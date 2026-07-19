const { app } = require('@azure/functions');
const { EmailClient } = require('@azure/communication-email');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.http('contact', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'contact',
  handler: async (request, context) => {
    // Preflight — actual allowed origins are configured on the Function App (see DEPLOYMENT.md)
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { success: false, message: 'Invalid request body.' } };
    }

    const { name, email, company, message, website } = body || {};

    // Honeypot: a hidden "website" field that only bots fill in.
    // Accept-and-drop rather than reject, so bots don't learn the field is checked.
    if (website) {
      context.log('Honeypot triggered — dropping submission silently.');
      return { status: 200, jsonBody: { success: true } };
    }

    if (!name || !email || !message) {
      return { status: 400, jsonBody: { success: false, message: 'Name, email and message are required.' } };
    }
    if (!EMAIL_PATTERN.test(email)) {
      return { status: 400, jsonBody: { success: false, message: 'Please enter a valid email address.' } };
    }
    if (String(name).length > 200 || String(message).length > 5000 || String(company || '').length > 200) {
      return { status: 400, jsonBody: { success: false, message: 'Submission too long.' } };
    }

    const connectionString = process.env.ACS_CONNECTION_STRING;
    const senderAddress = process.env.ACS_SENDER_ADDRESS;
    const recipient = process.env.CONTACT_RECIPIENT_EMAIL || 'info@vnloc.com';

    if (!connectionString || !senderAddress) {
      context.error('Missing ACS_CONNECTION_STRING or ACS_SENDER_ADDRESS app setting.');
      return { status: 500, jsonBody: { success: false, message: 'Server is not configured to send email.' } };
    }

    try {
      const client = new EmailClient(connectionString);

      const poller = await client.beginSend({
        senderAddress,
        content: {
          subject: `New Enquiry — VNLOC Website — ${name}${company ? ' / ' + company : ''}`,
          plainText: `Name: ${name}\nEmail: ${email}\nCompany: ${company || '-'}\n\n${message}`,
          html: `<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Email:</strong> ${escapeHtml(email)}</p>
<p><strong>Company:</strong> ${escapeHtml(company || '-')}</p>
<p><strong>Message:</strong><br>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
        },
        recipients: {
          to: [{ address: recipient }],
        },
        replyTo: [{ address: email, displayName: name }],
      });

      await poller.pollUntilDone();

      return { status: 200, jsonBody: { success: true } };
    } catch (err) {
      context.error('Failed to send contact email:', err);
      return {
        status: 502,
        jsonBody: { success: false, message: 'Failed to send message. Please try again or email us directly.' },
      };
    }
  },
});
