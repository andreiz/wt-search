// The title the card shows (spec §5.3, §3.4). Feed titles repeat the episode number in many house
// styles. The Worker sends the raw feed title (search.ts sends the row's title as stored), so this
// function is the only place titles are cleaned. It strips the episode's own number with the same
// patterns as the pipeline's `split_title` (pipeline/src/wts/stems.py), tested against
// test/fixtures/titles.json.
//
// One difference, on purpose: `split_title` removes a marked number whatever it is; this removes
// only the episode's own. A marker naming another number is kept
// (`displayTitle("Greasy Ham | Wood Talk 595", 596)` stays whole), and the own number is still
// stripped from a leading or trailing position ("Ep. 5 Recap | 608" gives "Ep. 5 Recap").

const MARKED = /(?:(?:\bwood\s*talk|\bwt|\bep(?:isode)?\.?)[\s\-:#|–—]*|#\s*)(\d{1,4})\b/gi;
const LEADING = /^\s*(\d{1,4})\s*[-–—:|]/;
const TRAILING = /(?:^|[\s|:–—-])(\d{1,4})\s*$/;
const EDGE_SEPARATORS = /^[\s|:–—.-]+|[\s|:–—-]+$/g;

export function displayTitle(title: string, number: number | null): string {
  if (number === null) return title;
  let clean = title;
  const own = [...clean.matchAll(MARKED)].find((m) => Number(m[1]) === number);
  if (own) {
    clean = clean.slice(0, own.index) + clean.slice(own.index + own[0].length);
  } else {
    for (const pattern of [LEADING, TRAILING]) {
      const bare = pattern.exec(clean);
      if (bare && Number(bare[1]) === number) {
        // Everything before the digits is a separator or whitespace, so the first match is the group.
        const at = bare.index + bare[0].indexOf(bare[1]!);
        clean = clean.slice(0, at) + clean.slice(at + bare[1]!.length);
        break;
      }
    }
  }
  return clean.replace(EDGE_SEPARATORS, "") || title;
}
