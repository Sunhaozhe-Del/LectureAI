const $ = id => document.getElementById(id);
const defaults = {enabled:true, language:"zh", fontSize:20, mode:"fast", course:"general"};
chrome.storage.local.get(Object.keys(defaults), s => {
  $("enabled").checked = s.enabled !== false;
  $("language").value = s.language || defaults.language;
  $("fontSize").value = s.fontSize || defaults.fontSize;
  $("fontSizeValue").textContent = `${$("fontSize").value}px`;
  $("mode").value = s.mode || defaults.mode;
  $("course").value = s.course || defaults.course;
});
$("enabled").addEventListener("change", e => chrome.storage.local.set({enabled:e.target.checked}));
$("language").addEventListener("change", e => chrome.storage.local.set({language:e.target.value, summaryLanguage:e.target.value}));
$("fontSize").addEventListener("input", e => {$("fontSizeValue").textContent=`${e.target.value}px`;chrome.storage.local.set({fontSize:Number(e.target.value)})});
$("mode").addEventListener("change", e => chrome.storage.local.set({mode:e.target.value}));
$("course").addEventListener("change", e => chrome.storage.local.set({course:e.target.value}));
