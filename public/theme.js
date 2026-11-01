// Applied before first paint so a saved theme never flashes. Dark-first per the token sheet.
try {
  var saved = localStorage.getItem('rivet-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (e) {}
