// Single source of truth for programming languages the "dsa" skill can be
// forced into. Add a new language here once and every code path (prompt
// injection, fence-tag enforcement, UI selects) picks it up.
const LANGUAGES = {
  cpp: { title: 'C++', fence: 'cpp' },
  c: { title: 'C', fence: 'c' },
  python: { title: 'Python', fence: 'python' },
  java: { title: 'Java', fence: 'java' },
  javascript: { title: 'JavaScript', fence: 'javascript' },
  js: { title: 'JavaScript', fence: 'javascript' },
  dart: { title: 'Dart', fence: 'dart' },
};

function getLanguageTitle(lang) {
  const norm = String(lang || '').toLowerCase();
  return (LANGUAGES[norm] && LANGUAGES[norm].title) ||
    (lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : 'text');
}

function getLanguageFence(lang) {
  const norm = String(lang || '').toLowerCase();
  return (LANGUAGES[norm] && LANGUAGES[norm].fence) || norm || 'text';
}

module.exports = { LANGUAGES, getLanguageTitle, getLanguageFence };
