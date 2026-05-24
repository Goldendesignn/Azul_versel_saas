# Configuration du Web Push Azul

Ces etapes activent les notifications PWA meme quand l'application est fermee.

## 1. Generer les cles VAPID

```bash
node tools/generate-vapid-keys.mjs
```

Copie `VAPID_PUBLIC_KEY` dans `JS/push-config.js`.

Ne mets jamais `VAPID_PRIVATE_KEY` dans le frontend ni dans GitHub.

## 2. Configurer les secrets Supabase

```bash
supabase secrets set VAPID_PUBLIC_KEY="TA_CLE_PUBLIQUE"
supabase secrets set VAPID_PRIVATE_KEY="TA_CLE_PRIVEE"
supabase secrets set VAPID_SUBJECT="mailto:ton-email@domaine.com"
supabase secrets set EDGE_FUNCTION_SECRET="UN_SECRET_LONG_ALEATOIRE"
```

## 3. Deployer la Edge Function

```bash
supabase functions deploy send-push-notification --no-verify-jwt
```

## 4. Executer le SQL

Dans Supabase SQL Editor, execute:

```sql
-- D'abord le fichier SQL/push_notifications.sql

alter database postgres set app.edge_send_push_url = 'https://TON-PROJET.supabase.co/functions/v1/send-push-notification';
alter database postgres set app.edge_function_secret = 'LE_MEME_SECRET_EDGE_FUNCTION_SECRET';
select pg_reload_conf();
```

## 5. Tester

1. Publie le site sur Vercel.
2. Ouvre l'ERP comme PWA.
3. Clique sur `Ativar PWA`.
4. Ferme l'application.
5. Depuis un autre utilisateur, enregistre une vente, un achat ou une depense.

Le proprietaire ou le gerant doit recevoir la notification meme si l'application est fermee.
