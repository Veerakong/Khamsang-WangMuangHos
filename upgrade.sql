-- =====================================================================
-- อัปเกรดเป็นเวอร์ชัน 2 (เพิ่มสิทธิ์ผู้ดูแลระบบ)
-- วิธีใช้: Supabase > SQL Editor > New snippet > แก้อีเมลบรรทัดที่ระบุ > วางทั้งไฟล์ > Run
-- รันซ้ำได้โดยไม่เสียหาย
-- =====================================================================

-- 1) เพิ่มคอลัมน์ผู้ดูแลระบบ
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- 2) ตั้งบัญชีของคุณเป็นผู้ดูแลระบบ
--    >>> แก้ 'General@egp.local' ให้เป็นอีเมลของบัญชีที่คุณใช้ล็อกอิน (ต้องผูกหน่วยงานแล้ว) <<<
update public.profiles set is_admin = true
 where id = (select id from auth.users where email = 'hr01@egp.local');

-- 3) ผู้ดูแลระบบแก้ไข/ยกเลิกเลขของทุกหน่วยงานได้ (ผู้ใช้ทั่วไปยังทำได้เฉพาะหน่วยงานตัวเอง)
create or replace function public.update_order(
  p_id bigint, p_order_date date, p_project text, p_price numeric,
  p_company text, p_members jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare prof public.profiles;
begin
  select * into prof from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'ไม่มีสิทธิ์'; end if;
  update public.orders
     set order_date = p_order_date, project = trim(p_project), price = p_price,
         company = trim(p_company), members = coalesce(p_members,'[]'::jsonb),
         updated_at = now()
   where id = p_id and (agency = prof.agency or prof.is_admin);
  if not found then raise exception 'แก้ไขไม่ได้ (คนละหน่วยงานหรือไม่พบรายการ)'; end if;
end $$;

create or replace function public.void_order(p_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare prof public.profiles;
begin
  select * into prof from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'ไม่มีสิทธิ์'; end if;
  update public.orders
     set status = 'void', void_reason = nullif(trim(p_reason),''), void_at = now()
   where id = p_id and (agency = prof.agency or prof.is_admin);
  if not found then raise exception 'ยกเลิกไม่ได้ (คนละหน่วยงานหรือไม่พบรายการ)'; end if;
end $$;

-- 4) ผู้ดูแลระบบคืนสถานะเลขที่ยกเลิกไปแล้วได้
create or replace function public.restore_order(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare prof public.profiles;
begin
  select * into prof from public.profiles where id = auth.uid() and active and is_admin;
  if not found then raise exception 'เฉพาะผู้ดูแลระบบ'; end if;
  update public.orders set status = 'active', void_reason = null, void_at = null where id = p_id;
  if not found then raise exception 'ไม่พบรายการ'; end if;
end $$;

revoke all on function public.restore_order(bigint) from public, anon;
grant execute on function public.restore_order(bigint) to authenticated;

-- 5) สิทธิ์อ่านตาราง (ถ้าเคยรันแล้วไม่เป็นไร)
grant usage on schema public to anon, authenticated;
grant select on public.orders, public.settings to anon, authenticated;
grant select on public.profiles to authenticated;

-- ตรวจผล: ต้องเห็นบัญชีของคุณที่ is_admin = true
select u.email, p.name, p.agency, p.active, p.is_admin
  from public.profiles p join auth.users u on u.id = p.id;
