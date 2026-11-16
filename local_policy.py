"""Pure local policies: bilingual scope and completed-sentence streaming."""
import re

def bilingual_choice(detected, probabilities):
    if detected in ('en','zh'):
        return detected
    probs = dict(probabilities or [])
    if probs.get('en',0)+probs.get('zh',0) < .1:
        return None
    return max(('en','zh'),key=lambda lang:probs.get(lang,0))

def completed_sentence(text):
    # A decimal point is not an endpoint; short filler alone is not a useful answer.
    minimum = 4 if re.search(r'[\u4e00-\u9fff]',text) else 8
    for match in re.finditer(r'\.(?=\s)|[!?。！？]',text):
        if match.end() >= minimum:
            return text[:match.end()].strip()
    return None

def spoken_sentences(text):
    """Keep version/decimal dots intact when limiting spoken output."""
    return re.findall(r'.+?(?:\.(?=\s|$)|[!?。！？]|$)',text)

_REPEAT_STRIP = re.compile(r'[\s，。！？、；：,.!?;:"“”‘’\'()（）\[\]【】\-—…·]+')
def normalize_for_repeat(text):
    """Punctuation/space-insensitive form for repeat detection."""
    return _REPEAT_STRIP.sub('', (text or '').lower())
def is_repeat(previous, current):
    """True when the new reply is the previous turn's reply verbatim
    (modulo punctuation/spacing). The 1.5B model latched onto one canned
    sentence for five straight turns on call 9f36a3a6 (2026-11-12)."""
    if not previous: return False
    a, b = normalize_for_repeat(previous), normalize_for_repeat(current)
    return bool(a) and a == b
def repeat_fallback(text):
    """Brief acknowledgment used when a regenerated reply still repeats:
    breaks the loop audibly instead of parroting a third time."""
    if any('\u4e00' <= c <= '\u9fff' for c in (text or '')): return '好的，我在听，请继续。'
    return 'Got it — go ahead.'

def is_repeat_of_recent(recent, current):
    """Repeat check against the last few replies, not just the previous
    one: on call ba87ef9d the turn-3 excuse sentence recurred verbatim at
    turn 5 with a different reply in between, slipping a window-1 guard."""
    return any(is_repeat(r, current) for r in (recent or []))
