import type { DiseaseAssessment } from "@agrofusion/shared";
import { FARMER_MESSAGES } from "@agrofusion/shared";
import { prisma } from "../../config/prisma.js";
import { llmClient, LlmUnavailableError } from "../../llm/client.js";
import { DISEASE_SYSTEM_PROMPT } from "../../llm/prompts.js";
import { knowledgeRetrieval } from "../../knowledge/retrieval.js";
import { validateDiseaseLlmJson, safeDiseaseFallback } from "../../validation/diseaseAssessment.js";
import { logLlm } from "../llmLogger.js";
import { AppError } from "../../utils/http.js";

export interface DiseaseAssessmentService {
  assess(input: {
    userId: string;
    cropCycleId: string;
    cropName: string;
    soilName: string;
    regionName: string;
    imageBase64: string;
    mimeType: string;
    imageKey: string;
  }): Promise<DiseaseAssessment>;
}

const DISEASE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    status: {
      type: "STRING",
      enum: [
        "VALID_ASSESSMENT",
        "UNCERTAIN",
        "INVALID_IMAGE",
        "INSUFFICIENT_IMAGE_QUALITY",
        "CROP_MISMATCH",
        "UNSUPPORTED",
        "MISSING_INFORMATION",
      ],
    },
    image_relevant: { type: "BOOLEAN" },
    crop_match: { type: "BOOLEAN" },
    identified_crop: { type: "STRING" },
    image_quality_sufficient: { type: "BOOLEAN" },
    is_healthy: { type: "BOOLEAN" },
    disease_common_name: { type: "STRING" },
    disease_scientific_name: { type: "STRING" },
    confidence: { type: "NUMBER" },
    visible_symptoms: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    risk_level: {
      type: "STRING",
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    },
    treatment_available: { type: "BOOLEAN" },
    treatment: {
      type: "OBJECT",
      properties: {
        medicine_name: { type: "STRING" },
        dosage: { type: "STRING" },
        application_method: { type: "STRING" },
        timing_frequency: { type: "STRING" },
      },
    },
    consequences_if_untreated: { type: "STRING" },
    probable_cause: { type: "STRING" },
    precautions: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    message: { type: "STRING" },
  },
  required: ["status", "confidence"],
};

async function enrichRawDisease(raw: unknown, cropName: string): Promise<unknown> {
  if (!raw || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  if (obj.status !== "VALID_ASSESSMENT" || obj.is_healthy === true) {
    return obj;
  }

  const effectiveCrop =
    (typeof obj.identified_crop === "string" && obj.identified_crop.trim()) || cropName;

  // 1. If disease_common_name is missing, try extraction from message
  if (
    (!obj.disease_common_name ||
      typeof obj.disease_common_name !== "string" ||
      !obj.disease_common_name.trim()) &&
    typeof obj.message === "string"
  ) {
    const match = obj.message.match(
      /Symptoms consistent with\s+([^(.]+?)(?:\s*\(([^)]+)\))?\s+detected/i,
    );
    if (match) {
      obj.disease_common_name = match[1].trim();
      if (!obj.disease_scientific_name && match[2]) {
        obj.disease_scientific_name = match[2].trim();
      }
    } else {
      const simpleMatch = obj.message.match(
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Rust|Blight|Spot|Rot|Mildew|Mosaic|Curl|Wilt|Canker|Blast))/i,
      );
      if (simpleMatch) {
        obj.disease_common_name = simpleMatch[1].trim();
      }
    }
  }

  const diseaseName =
    (typeof obj.disease_common_name === "string" && obj.disease_common_name.trim()) ||
    "Foliar Pathological Condition";

  // Look up knowledge base for grounded details
  const match = await knowledgeRetrieval.findTreatment(diseaseName, effectiveCrop);
  const sciMatch =
    typeof obj.disease_scientific_name === "string" && obj.disease_scientific_name.trim()
      ? await knowledgeRetrieval.findTreatment(obj.disease_scientific_name, effectiveCrop)
      : null;
  const kbEntry = match ?? sciMatch;

  // 2. Probable cause enrichment
  if (
    !obj.probable_cause ||
    (typeof obj.probable_cause === "string" && !obj.probable_cause.trim())
  ) {
    obj.probable_cause =
      kbEntry?.probableCause?.trim() ||
      `Pathogen infection favored by humidity, leaf wetness, and warm microclimate affecting ${effectiveCrop} foliage.`;
  }

  // 3. Consequences if untreated enrichment
  if (
    !obj.consequences_if_untreated ||
    (typeof obj.consequences_if_untreated === "string" && !obj.consequences_if_untreated.trim())
  ) {
    obj.consequences_if_untreated =
      kbEntry?.consequencesIfUntreated?.trim() ||
      `Progressive foliar damage leading to premature leaf drop, impaired photosynthesis, and significant yield loss in ${effectiveCrop} if left unmanaged.`;
  }

  // 4. Treatment enrichment if missing from model but present in KB
  if (!obj.treatment && kbEntry?.medicineName && kbEntry?.dosage) {
    obj.treatment = {
      medicine_name: kbEntry.medicineName,
      dosage: kbEntry.dosage,
      application_method: kbEntry.applicationMethod || "Foliar spray with uniform coverage",
      timing_frequency: kbEntry.timingFrequency || "At first symptom appearance",
    };
    obj.treatment_available = true;
  }

  // 5. Precautions enrichment
  if (
    (!obj.precautions || !Array.isArray(obj.precautions) || obj.precautions.length === 0) &&
    Array.isArray(kbEntry?.precautionsJson)
  ) {
    obj.precautions = kbEntry.precautionsJson;
  }

  return obj;
}

export class VisionLLMDiseaseService implements DiseaseAssessmentService {
  async assess(input: Parameters<DiseaseAssessmentService["assess"]>[0]): Promise<DiseaseAssessment> {
    const kb = await knowledgeRetrieval.forDisease(input.cropName);
    const kbText = knowledgeRetrieval.formatForPrompt(kb);
    const kbPromptSection = kb.length
      ? `VERIFIED KNOWLEDGE BASE EXCERPTS:\n${kbText}`
      : "VERIFIED KNOWLEDGE BASE EXCERPTS:\nPrioritize standard ICAR and agricultural extension recommendations for active ingredients, dosage, and cultural practices.";

    const userPrompt = [
      `Registered field crop: ${input.cropName}`,
      `Soil type: ${input.soilName}`,
      `Agro-climatic region: ${input.regionName}`,
      kbPromptSection,
      "Analyze the attached plant leaf/crop image. Diagnose any pathology or health state with high diagnostic precision.",
      "If the plant in the photo differs from the registered field crop, set crop_match: false, populate identified_crop, and provide full disease diagnosis for the observed plant.",
      "CRITICAL REQUIREMENTS FOR ACCURATE ASSESSMENT:",
      "- If disease or foliar damage is present: You MUST populate disease_common_name, disease_scientific_name, probable_cause, consequences_if_untreated, risk_level, visible_symptoms, precautions, and treatment (with medicine_name and dosage).",
      "- If plant is healthy: Set is_healthy: true, disease_common_name: null, and treatment: null.",
      "Return valid JSON matching the schema.",
    ].join("\n\n");

    const run = async () =>
      llmClient.completeJson({
        system: DISEASE_SYSTEM_PROMPT,
        user: userPrompt,
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
        responseSchema: DISEASE_RESPONSE_SCHEMA,
      });

    const started = Date.now();
    try {
      let raw = await run();
      raw = await enrichRawDisease(raw, input.cropName);
      let validated = await validateDiseaseLlmJson(raw, input.cropName);
      if (!validated.ok) {
        raw = await run();
        raw = await enrichRawDisease(raw, input.cropName);
        validated = await validateDiseaseLlmJson(raw, input.cropName);
      }
      const latencyMs = Date.now() - started;
      if (!validated.ok) {
        await logLlm({
          endpoint: "disease.scan",
          userId: input.userId,
          input: { crop: input.cropName, cropCycleId: input.cropCycleId },
          output: raw,
          latencyMs,
          validationStatus: "FAILED",
          flagged: true,
          errorMessage: validated.reason,
        });
        return safeDiseaseFallback();
      }
      await logLlm({
        endpoint: "disease.scan",
        userId: input.userId,
        input: { crop: input.cropName, cropCycleId: input.cropCycleId },
        output: validated.value,
        confidence: validated.value.confidence,
        latencyMs,
        validationStatus: "PASSED",
        flagged: validated.flagged,
      });
      return validated.value;
    } catch (err) {
      const latencyMs = Date.now() - started;
      await logLlm({
        endpoint: "disease.scan",
        userId: input.userId,
        input: { crop: input.cropName, cropCycleId: input.cropCycleId },
        latencyMs,
        validationStatus: "FAILED",
        flagged: true,
        errorMessage: err instanceof Error ? err.message : "llm_error",
      });
      if (err instanceof LlmUnavailableError) {
        return {
          status: "MISSING_INFORMATION",
          message:
            "Disease image analysis is not available because GEMINI_API_KEY is not configured. Image was saved. Add your Gemini key to .env to enable assessment.",
        };
      }
      if (err instanceof AppError) {
        const detail = typeof err.details === "string" ? err.details : "";
        if (detail.includes("Unable to process input image") || detail.includes("INVALID_ARGUMENT")) {
          return {
            status: "INSUFFICIENT_IMAGE_QUALITY",
            treatment_available: false,
            treatment: null,
            message: FARMER_MESSAGES.poorImage,
          };
        }
        return { status: "UNSUPPORTED", message: FARMER_MESSAGES.llmFailure };
      }
      return safeDiseaseFallback();
    }
  }
}

/** Future: dedicated classifier. Not used in V1. */
export class CustomMLDiseaseService implements DiseaseAssessmentService {
  async assess(): Promise<DiseaseAssessment> {
    return safeDiseaseFallback();
  }
}

export class HybridDiseaseService implements DiseaseAssessmentService {
  constructor(
    private readonly vision: DiseaseAssessmentService,
    _ml?: DiseaseAssessmentService,
  ) {}
  assess(input: Parameters<DiseaseAssessmentService["assess"]>[0]) {
    return this.vision.assess(input);
  }
}

export const diseaseAssessmentService: DiseaseAssessmentService = new VisionLLMDiseaseService();

export async function persistDiseaseScan(
  cropCycleId: string,
  imageKey: string,
  result: DiseaseAssessment,
) {
  return prisma.diseaseScan.create({
    data: {
      cropCycleId,
      imageKey,
      status: result.status,
      imageRelevant: result.image_relevant,
      cropMatch: result.crop_match,
      imageQualitySufficient: result.image_quality_sufficient,
      isHealthy: result.is_healthy ?? undefined,
      diseaseCommonName: result.disease_common_name,
      diseaseScientificName: result.disease_scientific_name,
      riskLevel: result.risk_level,
      treatmentJson: result.treatment ? JSON.parse(JSON.stringify(result.treatment)) : undefined,
      consequencesIfUntreated: result.consequences_if_untreated,
      precautionsJson: result.precautions ?? [],
      probableCause: result.probable_cause,
      confidence: result.confidence,
      visibleSymptomsJson: result.visible_symptoms ?? [],
      message: result.message,
    },
  });
}
