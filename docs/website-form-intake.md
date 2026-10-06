# Website form → LPO Sales Engine: submission contract

This is the contract for a Shopify theme section (Liquid + a little JavaScript) that submits a form to the LPO Sales Engine. The Sales Engine side is already live. Your job is the page: render the form, post the JSON described below, and show success or failure to the visitor.

What happens after you post: the Sales Engine creates a deal for a new person (or adds a note to their existing deal), assigns it to a sales rep, puts the message and every extra field on the deal timeline, and subscribes the person to the Klaviyo list that the LPO admin picked for this form. You do not call Klaviyo and you do not need any API key.

## Endpoint

```
POST https://lpo-sales-engine.vercel.app/api/webhooks/web-form
Content-Type: application/json
```

- CORS is enabled for `*.lonepeakoverland.com`, `lone-peak-overland.myshopify.com`, and `*.shopifypreview.com`, so a plain browser `fetch` from the storefront or the theme editor preview works. Any other origin gets a 403.
- No authentication header. There is no secret in the page.
- Also accepts `application/x-www-form-urlencoded` / `multipart/form-data` (a bare `<form method="post">` works), but use `fetch` with JSON so the visitor stays on the page.

## Request body

| Field | Required | Notes |
|---|---|---|
| `form` | yes | The form key configured in the Sales Engine. For the demo request form this is exactly `"demo-request"`. |
| `email` | yes* | *Either `email` or `phone` is required. Email is strongly preferred: without it the person cannot be added to Klaviyo. |
| `phone` | yes* | Any format; US 10-digit numbers are normalized. |
| `name` | no | Full name. Or send `first_name` and `last_name` instead; both styles are accepted. |
| `page_url` | no | `window.location.href`. Shown on the deal as "Submitted from …". |
| `sms_consent` | no | `true` only when the visitor ticked an explicit SMS marketing checkbox. Without it only email consent is recorded. |
| `submission_id` | no | A random id you generate per submission (e.g. `crypto.randomUUID()`). Lets a retried request not create a second deal. If omitted, the same email within 10 minutes is treated as one submission anyway. |
| `website` | no | **Honeypot.** Render it as a hidden text input and leave it empty. If it has a value the server answers `{ok:true}` and discards the submission. |
| anything else | no | Every other key you send (`message`, `truck`, `truck_year`, `location`, `timeline`, `how_did_you_hear`, …) is written to the deal as a note, one line per field in the form `key: value`. Underscores become spaces in the label. Keep keys short and snake_case. Values are capped at 2,000 characters. |

You may also nest extra fields under a `fields` object; they are treated the same as top-level extra keys.

A `truck` field, if present, is additionally stored on the Klaviyo profile as a `truck` property, so name the truck make/model field exactly `truck` if the form has one.

### Example

```json
{
  "form": "demo-request",
  "first_name": "Jordan",
  "last_name": "Lee",
  "email": "jordan@example.com",
  "phone": "(509) 555-0142",
  "truck": "2023 Toyota Tacoma",
  "location": "Boise, ID",
  "message": "Interested in seeing the camper in person next month.",
  "page_url": "https://lonepeakoverland.com/pages/demo-request",
  "sms_consent": false,
  "submission_id": "6a2f0c9e-6a0c-4c5c-9b4e-2f8f1d0a7b11",
  "website": ""
}
```

## Responses

All responses are JSON.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok": true}` | Recorded. Show the thank-you state. |
| 400 | `{"ok": false, "error": "email or phone required"}` | Also `"form required"` or `"invalid body"`. Validate on the page before posting so visitors rarely see these. |
| 403 | `{"ok": false, "error": "origin not allowed"}` | The page is not on an allowed domain. |
| 404 | `{"ok": false, "error": "unknown form"}` | The `form` key does not match an enabled engine. Check the spelling of `demo-request`. |
| 429 | `{"ok": false, "error": "too many submissions, try again later"}` | More than 5 submissions from one IP in 10 minutes. |
| 500 | `{"ok": false, "error": "could not record submission"}` | Server-side failure. Show a generic error with a fallback (phone number or email link). |

Treat anything other than `ok: true` as a failure and let the visitor retry. Reuse the same `submission_id` on retry.

## Page behavior to implement

1. Render the form with: first name, last name, email, phone, and whatever qualifying questions LPO wants (truck, location, message). Mark email required in the markup.
2. Include the honeypot: `<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">`. Do not use `type="hidden"`; bots skip hidden inputs, and the point is for them to fill this one in.
3. On submit: `preventDefault`, disable the button, build the JSON object from the fields plus `form`, `page_url`, and `submission_id`, and `fetch` it with `method: "POST"`, `headers: {"content-type": "application/json"}`, `body: JSON.stringify(payload)`.
4. On `ok: true`, replace the form with a thank-you message (make the heading and text theme settings). On anything else, re-enable the button and show the error text or a generic message.
5. Expose the form key as a section setting with default `demo-request`, so the same section can later serve a different form by changing one setting. Each distinct key needs an engine on the Sales Engine side; LPO sets that up.
6. Do not add Klaviyo's own form embed or any Klaviyo script for this form. The Sales Engine handles the list subscription.

### Minimal submit handler

```js
const form = document.querySelector('[data-lpo-form]');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.form = form.dataset.lpoForm;          // "demo-request"
  payload.page_url = location.href;
  payload.submission_id = form.dataset.sid ||= crypto.randomUUID();
  payload.sms_consent = form.querySelector('[name=sms_consent]')?.checked === true;
  try {
    const r = await fetch('https://lpo-sales-engine.vercel.app/api/webhooks/web-form', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { form.replaceWith(/* thank-you node */); return; }
    showError(j.error || 'Something went wrong. Please try again.');
  } catch { showError('Network error. Please try again.'); }
  btn.disabled = false;
});
```

## Testing

From a terminal (no Origin header is sent, which the server allows for server-side callers):

```bash
curl -s -X POST https://lpo-sales-engine.vercel.app/api/webhooks/web-form \
  -H 'content-type: application/json' \
  -d '{"form":"demo-request","name":"Test Submission","email":"your.name+test@lonepeakoverland.com","message":"theme test"}'
```

Expect `{"ok":true}`. The deal appears in the Sales Engine CRM titled "Demo Request - Test Submission" within a few seconds; ask the LPO admin to confirm and to delete test deals afterward. Use a real mailbox you control if the Klaviyo list is double opt-in, because Klaviyo will send a confirmation email.

In the Shopify theme editor preview the origin is `*.shopifypreview.com`, which is allowed, so submissions from the preview are real and reach the CRM. Use obviously-test names.

## Field checklist for the demo request form

Suggested names, so the deal note and Klaviyo properties come out tidy:

- `first_name`, `last_name`, `email`, `phone`
- `truck` (make, model, year as one free-text field, or combine three selects into one value before posting)
- `location` (city/state)
- `timeline` (e.g. "This month", "1–3 months", "Just researching")
- `message`
- `sms_consent` (checkbox, optional, labeled as consent to text messages)
- `website` (honeypot)
