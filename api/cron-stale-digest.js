import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

const STALE_DAYS = 5;

export default async function handler(req, res) {
  // Vercel Cron sends a GET. Optionally protect with CRON_SECRET.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const { data: leads, error } = await supabase
      .from('enquiries')
      .select('first_name,last_name,whatsapp,course_interest,last_contacted,contact_attempts,created_at,status')
      .eq('status', 'active');
    if (error) throw error;

    const now = Date.now();
    const cutoff = STALE_DAYS * 86400000;

    // Stale = active, contacted at least once, last contact 5+ days ago
    const stale = (leads || []).filter(l => {
      if (!l.last_contacted) return false;
      return (now - new Date(l.last_contacted).getTime()) >= cutoff;
    }).sort((a, b) => new Date(a.last_contacted) - new Date(b.last_contacted));

    // Never-contacted = active, no contact logged, enquiry 5+ days old
    const neverContacted = (leads || []).filter(l => {
      if (l.last_contacted) return false;
      return (now - new Date(l.created_at).getTime()) >= cutoff;
    });

    if (!stale.length && !neverContacted.length) {
      return res.status(200).json({ success: true, message: 'No stale leads — nothing to send.' });
    }

    const daysAgo = (d) => Math.floor((now - new Date(d).getTime()) / 86400000);
    const waLink = (n) => `https://wa.me/${(n || '').replace(/\D/g, '')}`;

    const rowsHtml = (arr, kind) => arr.map(l => {
      const name = `${l.first_name || ''} ${l.last_name || ''}`.trim() || '—';
      const since = kind === 'stale'
        ? `${daysAgo(l.last_contacted)}d since contact · ${l.contact_attempts || 1} attempt(s)`
        : `${daysAgo(l.created_at)}d old · never contacted`;
      return `<tr>
        <td style="padding:10px 8px;border-bottom:1px solid #1a2238;font-weight:600">${name}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #1a2238;color:#d4a843">${l.course_interest || '—'}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #1a2238;color:#8a8070;font-size:12px">${since}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #1a2238"><a href="${waLink(l.whatsapp)}" style="color:#25d366;text-decoration:none">💬 WhatsApp</a></td>
      </tr>`;
    }).join('');

    const section = (title, arr, kind) => arr.length ? `
      <div style="color:#d4a843;font-size:14px;font-weight:700;margin:24px 0 8px">${title} (${arr.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:#8a8070;font-size:11px;text-transform:uppercase;letter-spacing:1px">
          <th style="text-align:left;padding:6px 8px">Name</th>
          <th style="text-align:left;padding:6px 8px">Course</th>
          <th style="text-align:left;padding:6px 8px">Status</th>
          <th style="text-align:left;padding:6px 8px">Action</th>
        </tr></thead>
        <tbody>${rowsHtml(arr, kind)}</tbody>
      </table>` : '';

    const html = `
      <div style="font-family:sans-serif;max-width:640px;margin:0 auto;background:#0a0e17;color:#faf6ed;padding:32px;border-radius:12px">
        <div style="color:#d4a843;font-size:22px;font-weight:700;margin-bottom:6px">😴 Stale Leads Digest</div>
        <div style="color:#8a8070;font-size:13px;margin-bottom:8px">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <div style="color:rgba(255,255,255,.6);font-size:14px;line-height:1.6">These active leads haven't been contacted in ${STALE_DAYS}+ days. A quick WhatsApp could bring them back.</div>
        ${section('🔕 Contacted but gone quiet', stale, 'stale')}
        ${section('📭 Never contacted yet', neverContacted, 'never')}
        <div style="margin-top:28px"><a href="https://halbergfin.org/adm.html" style="background:#d4a843;color:#0a0e17;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Open Dashboard →</a></div>
      </div>`;

    await resend.emails.send({
      from: 'Halberg Fin <onboarding@resend.dev>',
      to: process.env.NOTIFY_EMAIL,
      subject: `😴 ${stale.length + neverContacted.length} leads need a nudge — Halberg Fin`,
      html
    });

    return res.status(200).json({ success: true, stale: stale.length, neverContacted: neverContacted.length });
  } catch (e) {
    console.error('Digest error:', e);
    return res.status(500).json({ error: e.message });
  }
}
