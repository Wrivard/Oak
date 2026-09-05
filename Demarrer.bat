@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  pokelister — demarrage sans terminal
rem
rem  Double-clique ce fichier. Il lance les deux process (le worker et l'app),
rem  attend que l'app reponde, puis ouvre le navigateur.
rem
rem  Pour arreter : ferme les deux fenetres noires, ou lance Arreter.bat.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

if not exist ".env.local" (
  echo.
  echo   Il manque le fichier .env.local
  echo.
  echo   Copie .env.example en .env.local et renseigne DATABASE_URL.
  echo   Sans lui l'application ne peut pas joindre la base.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   Premiere utilisation : installation des dependances...
  call pnpm install || goto :erreur
)

rem Deja demarre ? Double-cliquer ce fichier deux fois est un geste normal
rem quand on n'est pas sur que ca a marche. Un SECOND worker n'echouerait pas
rem bruyamment : il tournerait a cote du premier, et l'appariement des lots
rem alloue ses numeros d'ordre par max(seq)+1, ce qui n'est pas sur a deux. Une
rem page se ferait ecraser en silence. Deux process doublent aussi les
rem connexions, et le pooler Supabase plafonne a 15.
powershell -NoProfile -Command ^
  "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'worker.index' }) { exit 1 }"
if errorlevel 1 (
  echo.
  echo   pokelister tourne deja.
  echo   Ouvre http://localhost:3000, ou lance Arreter.bat avant de redemarrer.
  echo.
  start "" http://localhost:3000
  ping -n 6 127.0.0.1 >nul
  exit /b 0
)

rem On reconstruit A CHAQUE FOIS. Ne construire que si .next est absent servait
rem un build perime apres chaque mise a jour du code, et on croyait que les
rem changements n'avaient pas ete appliques. La construction prend ~7 secondes.
echo   Construction de l'application...
call pnpm build || goto :erreur

rem Le journal du worker va dans un fichier : sa fenetre est reduite et
rem personne ne la regarde. Sans ca, un worker qui meurt au demarrage ne laisse
rem AUCUNE trace visible, et on envoie un lot entier en attendant qu'il se
rem passe quelque chose.
if not exist "logs" mkdir "logs"

rem On GARDE le journal precedent. La redirection `>` ecrase, et c'est
rem exactement le fichier qu'on veut lire : quand le worker meurt, le reflexe
rem est de relancer, et relancer effacait la seule explication.
if exist "logs\worker.log" (
  if exist "logs\worker.precedent.log" del "logs\worker.precedent.log"
  move /y "logs\worker.log" "logs\worker.precedent.log" >nul
)

echo   Demarrage du worker...
start "pokelister - worker" /min cmd /c "node --import tsx worker/index.ts > logs\worker.log 2>&1"

echo   Demarrage de l'application...
start "pokelister - app" /min cmd /c "node node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0"

rem On attend que l'app reponde avant d'ouvrir le navigateur : sinon on tombe
rem sur une page d'erreur et on croit que ca ne marche pas.
echo   Attente du demarrage...
set /a tentatives=0
:attendre
set /a tentatives+=1
ping -n 2 127.0.0.1 >nul
curl -s -o nul --max-time 2 http://127.0.0.1:3000/ 2>nul
if not errorlevel 1 goto :pret
if %tentatives% lss 60 goto :attendre

echo.
echo   L'application n'a pas repondu apres 60 secondes.
echo   Regarde la fenetre "pokelister - app" pour l'erreur.
pause
exit /b 1

:pret

rem Le worker est-il encore la ? C'est la panne qui ne se voit pas : l'app
rem demarre parfaitement sans lui, on peut envoyer des photos, et rien n'est
rem jamais traite.
powershell -NoProfile -Command ^
  "if (-not (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'worker.index' })) { exit 1 }"
if errorlevel 1 (
  echo.
  echo   LE WORKER NE TOURNE PAS. L'application va demarrer, mais rien de ce
  echo   que tu enverras ne sera traite. Dernieres lignes de logs\worker.log :
  echo.
  powershell -NoProfile -Command "if (Test-Path 'logs\worker.log') { Get-Content 'logs\worker.log' -Tail 12 } else { '  (aucun journal)' }"
  echo.
  echo   Journal complet : logs\worker.log  ^(execution precedente : logs\worker.precedent.log^)
  echo.
  pause
)

echo   Pret.
start "" http://localhost:3000

rem L'adresse reseau, pour reviewer depuis un telephone ou une tablette de la
rem maison. Le serveur ecoute deja sur toutes les interfaces (-H 0.0.0.0).
rem
rem On filtre les adresses APIPA (169.254.x) : elles apparaissent dans ipconfig
rem mais ne menent nulle part, et les afficher a cote des bonnes fait perdre du
rem temps a essayer la mauvaise.
echo.
echo   Sur cette machine   : http://localhost:3000
powershell -NoProfile -Command ^
  "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { '  Depuis le reseau    : http://{0}:3000' -f $_.IPAddress }" 
echo.
echo   L'application n'a pas de mot de passe : tout appareil du reseau peut
echo   l'ouvrir, envoyer des lots et modifier l'inventaire. C'est voulu chez toi.
echo   Sur un reseau que tu ne controles pas, ne lance pas ce fichier.
echo.
echo   Cette fenetre peut etre fermee. Les deux autres doivent rester ouvertes.
ping -n 16 127.0.0.1 >nul
exit /b 0

:erreur
echo.
echo   L'installation a echoue. Regarde le message ci-dessus.
pause
exit /b 1
