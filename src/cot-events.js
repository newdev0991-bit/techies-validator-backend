const normalizeCaption = value => (typeof value === 'string' ? value : '')
  .slice(0, 10000).toLowerCase().replace(/[’‘]/g, "'");

export function qualifySearchPost(post) {
  const caption = normalizeCaption(post?.message);
  if (!caption) return { qualified: false, reason: 'missing_caption' };

  // These phrases overwhelmingly described people, housing or employment in the
  // observed search sample. They are safe to remove before paid validation.
  const personal = /\b(?:willing to relocate|looking to relocate|open to relocat|seeking (?:a |an )?(?:job|role)|job search|curriculum vitae|cv\b|resume\b|moving (?:house|home)|i am moving|i'm moving|moving to (?:the|a) area)\b/.test(caption);
  const retrospective = /\b(?:anniversary|years? ago|looking back|how it started)\b/.test(caption);
  const currentEvent = /\b(?:we(?:'re| are) (?:now |officially )?(?:opening|open)|we(?:'ve| have) (?:just |now )?(?:moved|relocated)|opening (?:this|next)|open(?:ing)? (?:tomorrow|today)|now open|under new ownership|(?:cannot|can't) wait to open our doors)\b/.test(caption);
  if (personal && !currentEvent) return { qualified: false, reason: 'personal_or_employment_move' };
  if (retrospective && !currentEvent) return { qualified: false, reason: 'historical_event_only' };
  if (/\b(?:recruitment|we are hiring|we're hiring|job vacancy|apply for (?:the|this) role)\b/.test(caption) && !currentEvent)
    return { qualified: false, reason: 'recruitment_only' };

  const signals = {
    premises: /\b(?:new|newly refurbished)\s+premises\b|\bpremises (?:are|is) (?:now )?open\b/.test(caption),
    opening: /\b(?:grand opening|soft opening|opening our (?:new )?(?:doors|shop|store|salon|clinic|studio|restaurant|cafe|business|location)|(?:we(?:'re| are)|our (?:shop|store|salon|clinic|studio|restaurant|cafe|business) is) opening|until we open|we(?:'re| are) (?:now |officially )open|now open at|(?:cannot|can't) wait to open our doors|our (?:brand )?new showroom)\b/.test(caption),
    relocation: /\b(?:we(?:'ve| have) (?:now )?(?:moved|relocated)|we are moving to our new (?:location|premises|address)|relocated to [^.\n]{0,80}(?:our new address|new premises)|moving (?:our|the) (?:business|shop|store|salon|clinic|studio|restaurant|cafe|office)|new business address)\b/.test(caption),
    ownership: /\b(?:under new ownership|under new management|new owners? (?:of|at)|taken over (?:the|by))\b/.test(caption)
  };
  const signal = Object.keys(signals).find(key => signals[key]);
  return signal ? { qualified: true, signal } : { qualified: false, reason: 'no_explicit_business_event' };
}
