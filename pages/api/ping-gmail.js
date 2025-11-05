import { gmailClient } from './_gmail';

export default async function handler(req, res) {
  try {
    const gmail = gmailClient();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    res.status(200).json({ ok: true, emailAddress: profile.data.emailAddress });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
