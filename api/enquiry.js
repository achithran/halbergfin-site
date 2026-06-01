import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { first_name, last_name, email, whatsapp, course_interest, experience, message } = req.body;

  if (!first_name || !whatsapp) {
    return res.status(400).json({ error: 'first_name and whatsapp are required' });
  }

  // Normalised number (last 10 digits) for duplicate matching
  const waDigits = (whatsapp || '').replace(/\D/g, '');
  const waLast10 = waDigits.slice(-10);

  // ── DUPLICATE CHECK ──────────────────────────────
  // Pull existing enquiries and match on last 10 digits of the number
  let duplicate = null;
  try {
    const { data: existing } = await supabase
      .from('enquiries')
      .select('id, first_name, whatsapp')
      .order('created_at', { ascending: false });

    if (existing && existing.length) {
      duplicate = existing.find(row => {
        const rowDigits = (row.whatsapp || '').replace(/\D/g, '');
        return rowDigits === waDigits ||
               (rowDigits.length >= 10 && waLast10.length === 10 && rowDigits.slice(-10) === waLast10);
      });
    }
  } catch (e) {
    console.error('Dup-check error (continuing as new):', e);
  }

  // ── IF DUPLICATE: log re-submission, skip new row + email ──
  if (duplicate) {
    try {
      const parts = [];
      if (course_interest) parts.push(`Course: ${course_interest}`);
      if (experience) parts.push(`Experience: ${experience}`);
      if (message) parts.push(`Message: ${message}`);
      const detail = parts.length ? ` (${parts.join(' · ')})` : '';
      await supabase.from('activity_logs').insert([{
        enquiry_id: duplicate.id,
        note: `🔄 Re-submitted demo request form${detail}`
      }]);
    } catch (e) {
      console.error('Could not log re-submission:', e);
    }

    // User still sees success + WhatsApp redirect
    const waTextDup = encodeURIComponent(`Hi ${first_name}! 👋 Thanks for reaching out again to Halberg Fin. We'll be in touch shortly about ${course_interest || 'our courses'}!`);
    const waUrlDup = `https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${waTextDup}`;
    return res.status(200).json({ success: true, duplicate: true, waUrl: waUrlDup });
  }

  // ── NEW ENQUIRY: save to Supabase ────────────────
  const { data: inserted, error: dbError } = await supabase.from('enquiries').insert([{
    first_name,
    last_name,
    email,
    whatsapp,
    course_interest,
    experience,
    message
  }]).select('id').single();

  if (dbError) {
    console.error('Supabase error:', dbError);
    return res.status(500).json({ error: 'Database error', detail: dbError.message });
  }

  // ── CREATE IN-APP NOTIFICATIONS FOR ALL ACTIVE ADMINS ──
  // New leads go to the shared pool — notify everyone so the first available can claim.
  try {
    const { data: admins } = await supabase
      .from('admins')
      .select('id')
      .eq('active', true);
    if (admins && admins.length && inserted) {
      const rows = admins.map(a => ({
        admin_id: a.id,
        type: 'new_lead',
        title: `🎯 New lead: ${first_name} ${last_name || ''}`.trim(),
        body: `${course_interest || 'No course selected'}${whatsapp ? ' · ' + whatsapp : ''}`,
        lead_id: inserted.id
      }));
      await supabase.from('notifications').insert(rows);
    }
  } catch (e) {
    console.error('Notification insert error (non-fatal):', e);
  }

  // Send notification email to admin (new leads only)
  await resend.emails.send({
    from: 'Halberg Fin <onboarding@resend.dev>',
    to: process.env.NOTIFY_EMAIL,
    subject: `🎯 New Lead: ${first_name} ${last_name || ''} — ${course_interest || 'No course selected'}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0a0e17;color:#faf6ed;padding:32px;border-radius:12px">
        <div style="color:#d4a843;font-size:22px;font-weight:700;margin-bottom:20px">📩 New Enquiry — Halberg Fin</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px">Name</td><td style="padding:8px 0;font-weight:600">${first_name} ${last_name || ''}</td></tr>
          <tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px">WhatsApp</td><td style="padding:8px 0"><a href="https://wa.me/${whatsapp.replace(/\D/g,'')}" style="color:#25d366">${whatsapp}</a></td></tr>
          ${email ? `<tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px">Email</td><td style="padding:8px 0">${email}</td></tr>` : ''}
          <tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px">Course</td><td style="padding:8px 0;color:#d4a843;font-weight:700">${course_interest || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px">Experience</td><td style="padding:8px 0">${experience || '—'}</td></tr>
          ${message ? `<tr><td style="padding:8px 0;color:#8a8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top">Message</td><td style="padding:8px 0">${message}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px">
          <a href="https://wa.me/${whatsapp.replace(/\D/g,'')}" style="background:#25d366;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">💬 Reply on WhatsApp</a>
        </div>
      </div>
    `
  });

  // Build WhatsApp redirect URL
  const waText = encodeURIComponent(`Hi ${first_name}! 👋 Thanks for your interest in ${course_interest || 'our courses'} at Halberg Fin. We'll schedule your free demo class shortly. Meanwhile, feel free to ask anything here!`);
  const waUrl = `https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${waText}`;

  return res.status(200).json({ success: true, waUrl });
}
