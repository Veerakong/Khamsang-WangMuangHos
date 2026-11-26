// ส่วนหลังบ้านสำหรับหน้า "ผู้ดูแลระบบ" (รันบน Vercel)
// ใช้ Secret key ที่เก็บใน Environment Variables ของ Vercel เท่านั้น ห้ามใส่ key ในไฟล์นี้
const { createClient } = require('@supabase/supabase-js');

const DOMAIN = '@egp.local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg) { const e = new Error(msg); e.user = true; return e; }
function text(v, max, label) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > max) throw fail(label + ' ไม่ถูกต้อง');
  return s;
}
function password(v) {
  const s = String(v || '');
  if (s.length < 6 || s.length > 72) throw fail('รหัสผ่านต้องยาว 6-72 ตัวอักษร');
  return s;
}
function uuid(v) { if (!UUID.test(String(v || ''))) throw fail('รหัสบัญชีไม่ถูกต้อง'); return String(v); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'ใช้ได้เฉพาะ POST' });

  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า SUPABASE_URL และ SUPABASE_SECRET_KEY ใน Vercel (Settings > Environment Variables) แล้ว Redeploy' });
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });

  const sb = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // 1) ตรวจว่าผู้เรียกล็อกอินจริงและเป็นผู้ดูแลระบบ
    const { data: ud, error: ue } = await sb.auth.getUser(token);
    if (ue || !ud || !ud.user) return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    const { data: me } = await sb.from('profiles').select('id,is_admin,active').eq('id', ud.user.id).maybeSingle();
    if (!me || !me.active || !me.is_admin) return res.status(403).json({ error: 'ไม่มีสิทธิ์ผู้ดูแลระบบ' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    // 2) ทำคำสั่งตามที่ขอ
    switch (body.action) {
      case 'list': {
        const { data: profs, error } = await sb.from('profiles').select('id,name,agency,active,is_admin');
        if (error) throw error;
        const { data: ul, error: le } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (le) throw le;
        const byId = {};
        (ul.users || []).forEach(u => { byId[u.id] = u; });
        const accounts = (profs || []).map(p => ({
          id: p.id, name: p.name, agency: p.agency, active: p.active, is_admin: p.is_admin,
          email: (byId[p.id] || {}).email || '', last_sign_in_at: (byId[p.id] || {}).last_sign_in_at || null
        })).sort((a, b) => a.agency.localeCompare(b.agency, 'th') || a.email.localeCompare(b.email));
        return res.status(200).json({ accounts });
      }

      case 'create': {
        const username = String(body.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw fail('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z ตัวเลข . _ - ความยาว 2-30 ตัว');
        const name = text(body.name, 120, 'ชื่อ-สกุล');
        const agency = text(body.agency, 160, 'หน่วยงาน');
        const pw = password(body.password);
        const { data: cu, error: ce } = await sb.auth.admin.createUser({ email: username + DOMAIN, password: pw, email_confirm: true });
        if (ce) {
          if (/already|registered|exists/i.test(ce.message || '')) throw fail('ชื่อผู้ใช้นี้มีอยู่แล้ว');
          throw ce;
        }
        const { error: pe } = await sb.from('profiles').insert({ id: cu.user.id, name, agency, is_admin: !!body.is_admin });
        if (pe) { await sb.auth.admin.deleteUser(cu.user.id); throw pe; }
        return res.status(200).json({ ok: true, id: cu.user.id });
      }

      case 'resetPassword': {
        const { error } = await sb.auth.admin.updateUserById(uuid(body.id), { password: password(body.password) });
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      case 'update': {
        const id = uuid(body.id);
        const patch = {};
        if (body.name !== undefined) patch.name = text(body.name, 120, 'ชื่อ-สกุล');
        if (body.agency !== undefined) patch.agency = text(body.agency, 160, 'หน่วยงาน');
        if (body.active !== undefined) patch.active = !!body.active;
        if (body.is_admin !== undefined) patch.is_admin = !!body.is_admin;
        if (id === me.id && (patch.active === false || patch.is_admin === false)) {
          throw fail('ปิดบัญชีหรือถอดสิทธิ์ผู้ดูแลของตัวเองไม่ได้');
        }
        if (!Object.keys(patch).length) throw fail('ไม่มีข้อมูลที่จะแก้ไข');
        const { error } = await sb.from('profiles').update(patch).eq('id', id);
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      case 'delete': {
        const id = uuid(body.id);
        if (id === me.id) throw fail('ลบบัญชีของตัวเองไม่ได้');
        const { error } = await sb.auth.admin.deleteUser(id);
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      case 'setYear': {
        const y = parseInt(body.year, 10);
        if (!(y > 2500 && y < 2700)) throw fail('ปี พ.ศ. ไม่ถูกต้อง');
        const { error } = await sb.from('settings').upsert({ id: 1, year: y });
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      default:
        throw fail('ไม่รู้จักคำสั่ง');
    }
  } catch (e) {
    return res.status(e.user ? 400 : 500).json({ error: e.user ? e.message : ('เกิดข้อผิดพลาด: ' + (e.message || e)) });
  }
};
