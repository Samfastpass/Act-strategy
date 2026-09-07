// Strategy Explorer tab — placeholder. Next planned feature per
// PROJECT_NOTES.md: letting the user define and backtest arbitrary
// parameter combinations against full history. Nothing built yet.
window.Explorer = (function () {
  function render(container) {
    container.innerHTML =
      '<div class="panel">'
      + '<h2>Strategy explorer</h2>'
      + '<div class="loading" style="padding: 1rem 0;">Coming soon &mdash; define and backtest your own SMA/buffer/vol-gate combinations here.</div>'
      + '</div>';
  }
  return { render: render };
})();
