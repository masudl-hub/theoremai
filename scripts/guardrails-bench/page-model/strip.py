# Rows with their HTML markup removed: script and style blocks and comments dropped, tags removed, entities decoded,
# runs of blank lines and spaces collapsed. Every other field is kept.
# TAGS=html (the default) removes only HTML's own tags, so <tool_response>, <module> or an XML key stays; TAGS=all removes every tag.
# Usage: [TAGS=all] strip.py <in.jsonl> <out.jsonl>
import json, sys, re, html, os
HTML = ('a|abbr|article|aside|b|body|br|button|center|code|dd|div|dl|dt|em|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img'
        '|input|label|li|link|main|meta|nav|noscript|ol|option|p|pre|section|select|small|span|strong|sub|sup|svg|table|tbody|td'
        '|textarea|tfoot|th|thead|title|tr|u|ul')
TAG = r'</?[a-zA-Z][^>]*>' if os.environ.get('TAGS') == 'all' else rf'(?i)</?(?:{HTML})\b[^>]*>|<!doctype[^>]*>'
def strip(t):
    t = re.sub(r'(?is)<(script|style)\b.*?</\1\s*>', ' ', t); t = re.sub(r'(?s)<!--.*?-->', ' ', t)
    t = re.sub(TAG, ' ', t); t = html.unescape(t)
    return re.sub(r'\n\s*\n+', '\n\n', re.sub(r'[ \t]+', ' ', t)).strip()
if __name__ == '__main__':
    src, out = sys.argv[1:3]; n = 0
    with open(out, 'w') as o:
        for l in open(src):
            r = json.loads(l); s = strip(r['text']); n += s != r['text']; r['text'] = s; o.write(json.dumps(r) + '\n')
    print(n, 'rows changed')
