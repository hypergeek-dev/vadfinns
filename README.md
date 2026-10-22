# Vad finns?

En liten, mobilvänlig visuell samtalshjälp om mat. Barnen kan bläddra bland maten som finns hemma eller titta i hela bildbiblioteket. Adminvyn låter en vuxen uppdatera tillgänglighet och bilder; alla ändringar sparas på servern och syns för andra enheter efter omladdning.

## Färdig körbar version

Hämta ZIP-filen för ditt operativsystem från GitHub Releases, packa upp den och starta `vadfinns.exe` på Windows eller `vadfinns` på Linux. Programmet innehåller webbgränssnittet och de medföljande matbilderna. På Windows öppnas webbläsaren automatiskt.

Den lokala körbara versionen kräver inget Admin-lösenord och lyssnar endast på `127.0.0.1`. Data sparas i mappen `data` bredvid den plats där programmet startas. Starta med `--no-browser` om webbläsaren inte ska öppnas automatiskt.

För nätverksåtkomst måste `HOST`, `ADMIN_PASSWORD` och `SESSION_SECRET` anges. Produktionsläge vägrar starta utan ett lösenord på minst 12 tecken och en sessionshemlighet på minst 32 tecken.

## Kom igång lokalt

Krav: Node.js 22 eller senare.

```powershell
npm install
Copy-Item .env.example .env
```

Sätt ett eget långt lösenord och en slumpmässig sessionshemlighet i miljön. Node läser inte `.env` automatiskt, så i PowerShell kan du starta så här:

```powershell
$env:ADMIN_PASSWORD='ett-langt-eget-losenord'
$env:SESSION_SECRET='minst-32-slumpmassiga-tecken-for-sessioner'
npm run dev
```

Öppna `http://localhost:3000`. Vid lokal utveckling utan miljövariabler används lösenordet `vadfinns-dev`. Det reservlösenordet fungerar aldrig när `NODE_ENV=production`.

## Importera matbilder

Lägg JPG-, PNG- eller WebP-filer i mappen `assets` innan första start. Servern importerar dem automatiskt, skapar optimerade WebP-versioner och miniatyrer samt hoppar över identiska bilder. Namn tas från filnamnet; de medföljande filerna får korta svenska namn.

Efter start kan nya bilder läggas till direkt i **Admin** utan kodändringar. Bilddata och tillgänglighet ligger i `data/`. Mappen ska ligga på beständig disk och säkerhetskopieras i drift. Att markera en matbild som otillgänglig rör aldrig originalposten eller bilden. Åtgärden **Ta bort** raderar däremot posten och dess bearbetade bilder efter en tydlig bekräftelse.

## Kontroller

```powershell
npm run check
npm test
```

## Driftsättning

Applikationen är en vanlig Node-process och behöver ingen extern databas.

1. Kör `npm ci --omit=dev` på servern.
2. Sätt `NODE_ENV=production`, ett unikt `ADMIN_PASSWORD` på minst 12 tecken och ett slumpmässigt `SESSION_SECRET` på minst 32 tecken.
3. Montera `data/` på en beständig volym med skrivrättighet för processen.
4. Starta med `npm start` bakom en HTTPS-proxy. Sätt `PORT` om port 3000 inte passar.
5. Säkerhetskopiera `data/foods.json` och `data/media/` tillsammans.

Eftersom servern använder lokala filer ska en enda appinstans skriva till volymen. För flera parallella instanser bör lagret först bytas till delad objektlagring och databas.

## Struktur

- `assets/` – levererade källfotografier för första import
- `public/` – de tre klientvyerna och gemensam design
- `server/` – API, autentisering, bildbearbetning och filbaserad lagring
- `data/` – genererad beständig driftdata (ignoreras av Git)
