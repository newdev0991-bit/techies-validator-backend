import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('HTTP analysis includes deterministic contacts in the legacy response and prompt', async t => {
  let prompt;
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    prompt = JSON.parse(body).messages[1].content;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'GOOD' }) } }] }));
  });
  const modelPort = await listen(model);
  const server = http.createServer(app);
  const port = await listen(server);
  const previous = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
  process.env.OPENAI_API_KEY = 'local-test-only';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${modelPort}`;
  t.after(async () => {
    for (const [name, value] of [['OPENAI_API_KEY', previous.key], ['OPENAI_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await close(server); await close(model);
  });
  const proof = 'https://www.facebook.com/example/posts/12345';
  const response = await fetch(`http://127.0.0.1:${port}/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead: {
      'Company Name': 'Example business', 'Lead Proof URL': proof,
      fetchResults: { rawData: { inputUrl: proof, status: 'success', scrape: { success: true },
        business: { identityStatus: 'matched' }, contact: { phone: '01632960123',
          phoneVerified: true, phoneSource: 'facebook-page-contact', identityStatus: 'matched',
          sourceUrl: 'https://www.facebook.com/example/about' },
        address: { full: 'Example premises SW1A 1AA', verified: true,
          source: 'facebook-page-contact', sourceUrl: 'https://www.facebook.com/example/about' }
      } }
    } })
  });
  assert.equal(response.status, 200);
  const result = JSON.parse((await response.json()).content[0].text);
  assert.equal(result.contact_enrichment.phone.value, '01632960123');
  assert.equal(result.contact_enrichment.address.value, 'Example premises SW1A 1AA');
  assert.equal(result.needs_manual_review, true); // contacts do not provide a proof timestamp
  assert.match(prompt, /Phone Number: Provided \(01632960123\)/);
  assert.match(prompt, /Address: Example premises SW1A 1AA/);
  assert.doesNotMatch(prompt, /- Missing essential contact information/);
  assert.match(prompt, /locationQuote/);
});
