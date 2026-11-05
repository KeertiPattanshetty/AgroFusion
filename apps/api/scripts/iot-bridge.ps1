param(
  [string]$ComPort = 'COM5',
  [int]$BaudRate = 9600,
  [string]$ApiUrl = 'http://localhost:4000/api/iot/telemetry'
)

Write-Host "==================================================" -ForegroundColor Green
Write-Host "AGROFUSION ARDUINO USB SERIAL BRIDGE" -ForegroundColor Green
Write-Host "Reading from: $ComPort at $BaudRate baud" -ForegroundColor Cyan
Write-Host "Forwarding to: $ApiUrl" -ForegroundColor Cyan
Write-Host "=================================================="

while ($true) {
  $port = $null
  try {
    $port = New-Object System.IO.Ports.SerialPort $ComPort, $BaudRate
    $port.DtrEnable = $true
    $port.RtsEnable = $true
    $port.ReadTimeout = 5000
    $port.Open()
    Write-Host "Connected to $ComPort! Listening for sensor data from Arduino..." -ForegroundColor Green

    while ($port.IsOpen) {
      try {
        $line = $port.ReadLine().Trim()
        if ($line.StartsWith("{") -and $line.EndsWith("}")) {
          $res = Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $line -ContentType "application/json"
          Write-Host "[Sensor Data Forwarded]: $line" -ForegroundColor Yellow
        }
      } catch [System.TimeoutException] {
        # Normal timeout when waiting for sensor interval
      } catch {
        Write-Host "Read error: $($_.Exception.Message)" -ForegroundColor DarkGray
        Start-Sleep -Milliseconds 500
        if (-not $port.IsOpen) { break }
      }
    }
  } catch {
    Write-Host "Waiting for $ComPort to become free/connected: $($_.Exception.Message)" -ForegroundColor DarkYellow
    Start-Sleep -Seconds 3
  } finally {
    if ($port -and $port.IsOpen) {
      $port.Close()
    }
  }
  Start-Sleep -Seconds 2
}
