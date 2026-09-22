# Bridge Apps Script

Questo bridge riceve uno snapshot BancoPosta con un token monouso e aggiorna
Cloud Firestore senza richiedere a ChatGPT di accedere all'account Google.

## Configurazione una tantum

1. Crea un progetto Apps Script autonomo.
2. Copia `Code.gs` e abilita la visualizzazione del manifest, quindi copia
   `appsscript.json`.
3. In **Impostazioni progetto > Proprietà script**, crea `ALLOWED_UID` con
   l'UID Firebase del proprietario della web app.
4. Esegui una volta `doGet` dall'editor e autorizza i soli permessi richiesti.
5. Distribuisci come **App web**, eseguita come proprietario e accessibile a
   chiunque, inclusi gli utenti anonimi.
6. Copia l'URL `/exec` nella costante `SYNC_WEBHOOK_URL` di `index.html`.

Il repository non deve contenere l'UID autorizzato, token, credenziali, saldo o
movimenti. L'URL della Web app non è un segreto: ogni scrittura richiede anche
UID autorizzato, sessione Firebase valida, token casuale non riutilizzabile e
scadenza breve.
