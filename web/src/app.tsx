// The page shell (spec §5.1, §5.7; design: Screen.dc.html, README "Layout"): header brand row,
// main, footer. Search, results and the real footer land in Tasks 6-13; the heading in <main> is
// the design's empty-state title and stands in until Task 11.
export function App() {
  return (
    <div class="page">
      <header class="site-header">
        <div class="column site-header__inner">
          <a class="brand" href="/">
            Wood Talk Search
          </a>
          <span class="site-header__note">Unofficial · fan-made</span>
        </div>
      </header>
      <main class="column main">
        <section class="empty">
          <h1 class="empty__title">Find the moment it was said.</h1>
        </section>
      </main>
      <footer class="site-footer">
        <div class="column site-footer__inner">
          <p class="site-footer__line">
            <strong>Unofficial</strong> · made with the hosts' blessing
          </p>
          <p class="site-footer__line">Searches are logged anonymously to improve results.</p>
        </div>
      </footer>
    </div>
  );
}
