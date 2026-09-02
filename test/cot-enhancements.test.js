import test from 'node:test';
import assert from 'node:assert/strict';
import { proofQuote, contactTargetFromProof } from '../actor/src/contactTarget.js';
import { proofAddresses } from '../actor/src/proofAddress.js';
import { evaluateCotIdentity } from '../src/cot-identity.js';
import { enrichCotContacts } from '../src/cot-contacts.js';
import { qualifySearchPost, assess } from '../pipeline/records.mjs';

function evidence(name, caption) {
  const url='https://www.facebook.com/example/posts/123';
  const raw={inputUrl:url,postUrl:url,postText:caption,postAuthor:name,pageName:name,status:'success',scrape:{success:true},
    business:{identityStatus:'matched'},time_target_matched:true,time_confidence:'high',time_precision:'exact',time_is_estimated:false,
    time_target_match_method:'direct_post_url',posted_at_iso:'2026-09-01T12:00:00Z',
    contact:{phone:'01330 822177',phoneVerified:true,phoneSource:'facebook-page-page-text',identityStatus:'matched',sourceUrl:'https://www.facebook.com/example'},address:{}};
  const lead={'Company Name':name,'Search Post ID':'123','Lead Proof URL':url,fetchResults:{rawData:raw}};
  return {raw,lead};
}

test('SE Medical typography matches literal proof, but paraphrases and wrong pages do not',()=>{
  const caption='We’ve moved—and exciting things are coming!\nOur office has moved to:\nThe Olympic\nBeechenlea Lane\nSwanley\nBR8 8DR';
  const {raw,lead}=evidence('SE Medical',caption);
  const claim={businessName:'SE Medical',relationship:'self',evidenceQuote:"We've moved—and exciting things are coming!",locationQuote:'Swanley'};
  assert.equal(proofQuote(caption,claim.evidenceQuote),'We’ve moved—and exciting things are coming!');
  assert.equal(contactTargetFromProof(raw,claim).evidenceQuote,'We’ve moved—and exciting things are coming!');
  const identity=evaluateCotIdentity(lead,claim);
  assert.equal(identity.status,'matched');
  const contacts=enrichCotContacts(lead,identity);
  assert.equal(contacts.address.value,'The Olympic, Beechenlea Lane, Swanley, BR8 8DR');
  assert.equal(contacts.status,'complete');
  assert.equal(contactTargetFromProof(raw,{...claim,evidenceQuote:'We have relocated to a bigger office'}),null);
  raw.time_target_matched=false;
  assert.equal(contactTargetFromProof(raw,claim),null);
});

test('Deeside @ and adjacent address blocks extract without treating email or IDs as addresses',()=>{
  const caption='We are delighted to announce our new premises @ 16A Bridge Street, Banchory, AB31 5SX.';
  assert.equal(proofAddresses(caption)[0].value,'16A Bridge Street, Banchory, AB31 5SX');
  assert.equal(proofAddresses('Contact info@example.com at Bridge Street AB31 5SX').length,0);
  assert.equal(proofAddresses('Post ID 123456789 AB31 5SX').length,0);
});

test('Corinium suffix match requires verified identity and conflicting old/new premises stay in review',()=>{
  const caption='Corinium Paints has officially moved to our new premises!\nUnit 14C, Elliot Road\nCirencester, GL7 1YS';
  const {raw,lead}=evidence('Corinium-Paints LTD',caption);
  const claim={businessName:'Corinium Paints',relationship:'self',evidenceQuote:'Corinium Paints has officially moved to our new premises!',locationQuote:'new premises'};
  assert.ok(contactTargetFromProof(raw,claim));
  const identity=evaluateCotIdentity(lead,claim);assert.equal(identity.status,'matched');
  raw.address={full:'Unit 18 Elliott Road, Cirencester, United Kingdom',source:'facebook-page-contact',sourceUrl:'https://www.facebook.com/example',verified:true};
  const contacts=enrichCotContacts(lead,identity);
  assert.equal(contacts.address.conflict,true);assert.equal(contacts.status,'review_required');
  assert.equal(contacts.address.candidates.length,2);
  raw.business.identityStatus='unconfirmed';assert.equal(contactTargetFromProof(raw,claim),null);
});

test('opening variants survive while anniversary-only, employment and normal promotions are excluded',()=>{
  for(const message of ["WE’RE OFFICIALLY OPEN! Our new Galloway Jennings office is ready.","We cannot wait to open our doors! Newcastle’s first dog soft play.", 'Our NEW showroom in Derry is now open!'])
    assert.equal(qualifySearchPost({message}).qualified,true,message);
  for(const message of ['We received the keys to our new premises. We opened our doors a whole year ago!','I am moving house next week.','Our removals company helps clients relocate.','Our new menu is available.'])
    assert.equal(qualifySearchPost({message}).qualified,false,message);
  assert.equal(qualifySearchPost({message:'Our first anniversary! We are opening another shop tomorrow.'}).qualified,true);
});

test('24-hour boundary separates expiration from quality rejection and never refreshes proof time',()=>{
  const {raw,lead}=evidence('Example Ltd','We are opening our new premises at 16A Bridge Street, Banchory, AB31 5SX.');
  const row={lead,fetchResults:lead.fetchResults,analysis:{verdict:'GOOD',needs_manual_review:false,business_identity:{relationship:'self',businessName:'Example Ltd',evidenceQuote:raw.postText}}};
  const boundary=Date.parse(raw.posted_at_iso)+86400000;
  assert.equal(assess(row,boundary-1).status,'READY');assert.equal(assess(row,boundary).status,'READY');
  assert.equal(assess(row,boundary+1).status,'EXPIRED');
  row.analysis.verdict='BAD';assert.equal(assess(row,boundary+1).status,'REJECTED');
  row.analysis.verdict='GOOD';raw.time_target_matched=false;assert.equal(assess(row,boundary+1).status,'REVIEW_REQUIRED');
});

test('saved policy warnings are recomputed from retained original model evidence without overriding model uncertainty',()=>{
  const {raw,lead}=evidence('SE Medical','We’ve moved to our new premises!\n16A Bridge Street, Banchory AB31 5SX');
  const original={verdict:'GOOD',needs_manual_review:false,business_identity:{businessName:'SE Medical',relationship:'self',evidenceQuote:"We've moved to our new premises!"}};
  const row={lead,fetchResults:lead.fetchResults,analysis:{quality_assessment:original,verdict:'UNCLEAR',needs_manual_review:true,business_identity:{evidenceQuote:'',status:'unresolved'}}};
  const before=structuredClone(row),clock=Date.parse(raw.posted_at_iso)+3600000;
  assert.equal(assess(row,clock).status,'READY');assert.deepEqual(row,before);
  row.analysis.quality_assessment.needs_manual_review=true;assert.equal(assess(row,clock).status,'REVIEW_REQUIRED');
  row.analysis.quality_assessment.verdict='BAD';assert.equal(assess(row,clock).status,'REJECTED');
});
