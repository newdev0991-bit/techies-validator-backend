import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUkCaptionPhones } from '../actor/src/contactValues.js';
import { enrichCotContacts } from '../src/cot-contacts.js';

const url='https://www.facebook.com/example/posts/123';
const identity={status:'matched',relationship:'self',requiresManualReview:false};
const lead=caption=>({'Lead Proof URL':url,fetchResults:{rawData:{inputUrl:url,
 status:'success',scrape:{success:true},time_target_matched:true,postText:caption,
 business:{identityStatus:'matched'},contact:{}}}});

// Caption excerpts from needs-review 123.xlsx, Excel rows 6, 18 and 40.
for(const [row,caption,expected] of [
 [6,'Tel ; 07908650708\nEmail ; jcarrington@littlekickers.co.uk','07908650708'],
 [18,'📲 01926 919258\n📩 reception@humanity-warwick.co.uk','01926919258'],
 [40,'please give us a call if you have any questions 07988372315','07988372315']]){
 test(`report row ${row}: exact-caption recovery retains leading zero and provenance`,()=>{
  const input=lead(caption),before=structuredClone(input);
  const result=enrichCotContacts(input,identity);
  assert.equal(result.phone.value,expected);
  assert.equal(result.phone.sourceUrl,url);
  assert.equal(result.phone.verified,true);
  assert.deepEqual(input,before);
 });
}
test('unresolved/personal and third-party numbers remain candidates, not verified contacts',()=>{
 for(const id of [{status:'unresolved',relationship:'unknown',requiresManualReview:true},
  {status:'matched',relationship:'third_party',requiresManualReview:false}]){
  const result=enrichCotContacts(lead('Call 07908650708'),id);
  assert.equal(result.phone.value,'');assert.equal(result.phone.candidates[0].value,'07908650708');
  assert.equal(result.phone.candidates[0].verified,false);assert.ok(result.requiresManualReview);
 }
});
test('failed, wrong-row and unmatched-target evidence cannot even supply caption candidates',()=>{
 for(const mutate of [r=>r.scrape.success=false,r=>r.scrape.blocked=true,
  r=>r.inputUrl=url+'9',r=>r.time_target_matched=false,r=>r.business.wrongBusiness=true]){
  const input=lead('Call 07908650708');mutate(input.fetchResults.rawData);
  const result=enrichCotContacts(input,identity);
  assert.equal(result.phone.value,'');assert.deepEqual(result.phone.candidates,[]);
 }
});
test('conflicting observed numbers require review without silently replacing an existing number',()=>{
 const input=lead('Call 07908650708');
 input.fetchResults.rawData.contact={identityStatus:'matched',phone:'07988372315',phoneVerified:true,
  phoneSource:'facebook-page-contact',sourceUrl:'https://www.facebook.com/example/about'};
 const result=enrichCotContacts(input,identity);
 assert.equal(result.phone.value,'07988372315');assert.ok(result.phone.conflict);assert.ok(result.requiresManualReview);
 const multiple=enrichCotContacts(lead('Call 07908650708\nPhone 07988372315'),identity);
 assert.equal(multiple.phone.value,'');assert.ok(multiple.phone.conflict);
});
test('caption parsing excludes IDs, prices and arbitrary digit prose; accepts UK formatting',()=>{
 assert.deepEqual(extractUkCaptionPhones('Post ID 07908650708\nCall 079086507081234\nWe served 07908650708 customers\n£10 12 September 2026'),[]);
 assert.deepEqual(extractUkCaptionPhones('Tel +44 (0)1926 919258\n01926 919258'),['01926919258']);
});
test('identity-checked Google listings survive enrichment',()=>{
 for(const source of ['google-directory-listing','google-booking-listing','google-registry-listing']){
  const input=lead('Our new shop is open.');
  input.fetchResults.rawData.contact={identityStatus:'matched',phone:'01926919258',phoneVerified:true,
   source,phoneSource:source+'-tel',sourceUrl:'https://example.test/listing'};
  assert.equal(enrichCotContacts(input,identity).phone.value,'01926919258');
 }
});
