# Azul Gestao Production - installation Supabase V1

Ce guide sert a installer une base Supabase propre pour la version vendue de Azul.

## 1. Parametres Auth

Dans Supabase Production:

1. Va dans `Authentication > Sign In / Providers`.
2. Ouvre `Email`.
3. Active `Enable email provider`.
4. Dans `User Signups`, laisse `Allow new users to sign up` active.
5. Desactive `Confirm email` pour les tests et la vente simple par licence.
6. Sauvegarde.

## 2. SQL a executer dans l'ordre

Va dans `SQL Editor > New query`.

Execute les fichiers dans cet ordre exact:

1. `SQL/production_base_schema_v1.sql`
2. `SQL/corrections_log.sql`
3. `SQL/hr_module.sql`
4. `SQL/reseller_module.sql`
5. `SQL/reseller_audit_fix.sql`
6. `SQL/stock_transfers_history.sql`
7. `SQL/notifications.sql`
8. `SQL/push_notifications.sql`
9. `SQL/notifications_realtime.sql`
10. `SQL/action_permissions_roles_audit.sql`
11. `SQL/audit_user_fields_and_role_permissions.sql`
12. `SQL/team_roles_status.sql`
13. `SQL/team_role_management.sql`
14. `SQL/owner_approval_user_flow.sql`
15. `SQL/supabase_remote_functions.sql`

Le fichier `supabase_remote_functions.sql` doit rester a la fin, car il remet les dernieres versions des fonctions.

## 3. Creer ton compte admin

1. Ouvre `admin.html` ou `index.html`.
2. Cree ton compte Supabase Auth avec ton email.
3. Reviens dans Supabase `SQL Editor`.
4. Execute ce SQL en remplacant l'email si besoin:

```sql
insert into public.admin_users (user_id, email, active)
select id, email, true
from auth.users
where lower(email) = lower('mctrdcr1@gmail.com')
on conflict (user_id)
do update set
  email = excluded.email,
  active = true;
```

Ensuite l'admin pourra generer les licences depuis `admin.html`.

## 4. Notifications push

Pour les notifications en arriere-plan:

1. Suis aussi `PWA_PUSH_SETUP.md`.
2. Deploie la Edge Function `send-push-notification`.
3. Mets les secrets VAPID dans Supabase Production.
4. Dans `SQL/push_notifications.sql`, remplace le secret par le meme `EDGE_FUNCTION_SECRET`.

## 5. Vercel Production

La branche `release/v1` pointe vers:

```text
https://nekxpfooskfxeafbpjqp.supabase.co
```

Connecte donc ton projet Vercel Production a la branche:

```text
release/v1
```

Garde `develop` pour les tests et les nouvelles fonctions.
