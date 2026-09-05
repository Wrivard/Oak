@echo off
rem Arrete le worker et l'application pokelister.

echo   Arret des process pokelister...

rem On ne tue QUE nos process : filtrer sur la ligne de commande evite
rem d'emporter un autre node qui tournerait sur cette machine.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'worker.index|next.dist.bin.next' } | ForEach-Object { Write-Host ('  arret ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"

echo   Termine.
timeout /t 3 >nul
