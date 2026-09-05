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

rem On reconstruit A CHAQUE FOIS. Ne construire que si .next est absent servait
rem un build perime apres chaque mise a jour du code, et on croyait que les
rem changements n'avaient pas ete appliques. La construction prend ~7 secondes.
echo   Construction de l'application...
call pnpm build || goto :erreur

echo   Demarrage du worker...
start "pokelister - worker" /min cmd /c "node --import tsx worker/index.ts"

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
echo   Cette fenetre peut etre fermee. Les deux autres doivent rester ouvertes.
ping -n 16 127.0.0.1 >nul
exit /b 0

:erreur
echo.
echo   L'installation a echoue. Regarde le message ci-dessus.
pause
exit /b 1
