---
version: alpha
colors:
  paper: "#F3F6F4"
  surface: "#FFFFFF"
  ink: "#18312F"
  muted: "#5D706D"
  line: "#CDD8D4"
  primary: "#164B68"
  primaryHover: "#0E3C55"
  dill: "#32735A"
  dillSoft: "#DDECE4"
  danger: "#A63D40"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
  body:
    fontFamily: "'Avenir Next', Avenir, 'Segoe UI', system-ui, sans-serif"
  utility:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
rounded:
  small: "0.5rem"
  control: "0.875rem"
  photo: "1.5rem"
spacing:
  compact: "0.5rem"
  base: "1rem"
  roomy: "1.5rem"
components:
  photoFrame: { }
  focusRing: { }
---

# Vad finns? designriktning

## Overview

Gränssnittet ska kännas som en lugn, tålig bilderbok på ett skandinaviskt köksbord. Det är ett produktgränssnitt för två barn och deras pappa: fotografierna leder, kontrollerna är stora och språket är kort. Signaturen är de stora kantmonterade pilarna som ramar in bilden i huvudvyn. Undvik butikskänsla, receptestetik, spelifiering och instrumentpaneler på de publika sidorna.

Runtime-CSS i `public/styles.css` är den tekniska källan för tokens; den här filen speglar de accepterade värdena och förklarar användningen.

## Colors

`paper` är sidans svala pappersbakgrund, `surface` bär fotografier och dialoger, och `ink` är primär text. `primary` och `primaryHover` mappas till CSS-variablerna `--blue` och `--blue-hover` för navigation, fokus och huvudsakliga handlingar. `dill` och `dillSoft` betyder tillgänglig/vald och används alltid tillsammans med text eller bock. `danger` är reserverad för borttagning och fel.

## Typography

Georgia används sparsamt i sidtitlar för en bilderbokston. Avenir Next/Segoe UI bär all funktionell text. Utility-rollen används för räknare, status och små etiketter. Inga externa typsnitt laddas; sidan ska vara snabb och stabil även på långsam uppkoppling.

## Layout

Publika vyer är mobile-first. Huvudfotot ryms inom den tillgängliga höjden utan beskärning. Albumet använder stora responsiva kort, medan Admin använder tätare miniatyrer. Sidhuvudet får radbrytas på smala skärmar och respekterar säkra ytor.

## Elevation & Depth

Djup kommer främst från tunna linjer och en enda mjuk skugga på aktiva bildytor och dialoger. Statiska adminpaneler är flata.

## Shapes

Fotografier har generösa 24 px hörn. Kontroller har 14 px hörn; runda former är reserverade för ikonknappar och statusbockar.

## Components

Alla klickbara mål är semantiska knappar eller länkar med minst 44 px träffyta. Bildkort reserverar sin geometri. Toast och dialog delas mellan adminflöden. Scrollbarens grundtema ägs globalt av `public/styles.css`.

## Do's and Don'ts

- Låt fotografiet vara det största och mest färgstarka objektet.
- Skriv kort, naturlig svenska och behåll exakt “Kan du köpa?”.
- Visa tillgänglighet med bock, text och färg tillsammans.
- Lägg inte till kategorier, beställningar, omröstningar eller måltidslogik.
- Använd inte dekorativ rörelse; endast diskreta tillståndsövergångar som respekterar reducerad rörelse.
