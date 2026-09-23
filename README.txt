# Budget personale – PWA V4

Carica nella root del repository GitHub Pages:
- index.html
- manifest.json
- sw.js
- cartella icons/ con i tre PNG

Non modificare il Cloudflare Worker, Firebase o Enable Banking.

## Installazione Android
Apri la pagina in Chrome → menu ⋮ → "Installa app" / "Aggiungi a schermata Home".

## Installazione iPhone
Apri la pagina in Safari → Condividi → "Aggiungi alla schermata Home" → Aggiungi.

La PWA si apre in modalità standalone. Il service worker memorizza solo i file statici della UI; non memorizza risposte BancoPosta, Firebase o autenticazione.
