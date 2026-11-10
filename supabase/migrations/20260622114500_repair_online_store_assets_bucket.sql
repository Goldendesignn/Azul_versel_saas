insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'online-store-assets',
  'online-store-assets',
  true,
  83886080,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-m4v'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists online_store_assets_public_read on storage.objects;
create policy online_store_assets_public_read
on storage.objects
for select
to public
using (bucket_id = 'online-store-assets');

drop policy if exists online_store_assets_insert_by_org on storage.objects;
create policy online_store_assets_insert_by_org
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists online_store_assets_update_by_org on storage.objects;
create policy online_store_assets_update_by_org
on storage.objects
for update
to authenticated
using (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists online_store_assets_delete_by_org on storage.objects;
create policy online_store_assets_delete_by_org
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);
