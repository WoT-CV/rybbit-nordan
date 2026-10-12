// No crawl manifest: crawlers must be able to fetch the site's noindex responses.
export function GET() {
  return new Response(null, { status: 410, headers: { "Cache-Control": "no-store" } });
}
