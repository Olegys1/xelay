const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
export const cleanTitle = value => String(value || '').replace(/^\d+\.\s*/, '');
export function guideUpdatedLabel(version) {
  if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) return '';
  const date = new Date(`${version}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== version) return '';
  const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
  return `Оновлено ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} року.`;
}
export function buildGuide(value, audience) {
  if (!value || !Array.isArray(value.sections) || !value.sections.length) throw new Error('Посібник ще готується.');
  const sections = value.sections.map(section => ({...section,title:cleanTitle(section.title),steps:strings(section.steps),notes:strings(section.notes)}));
  if (strings(value.quickStart).length) sections.unshift({id:'__first-setup',title:'Короткий маршрут роботи',goal:value.intro,checklist:strings(value.quickStart),notes:['Позначки нижче зберігаються тільки у цьому браузері. Вони допомагають зорієнтуватися, але не перевіряють фактичні налаштування акаунта.','Після кожного пункту можна відкрити докладний розділ у меню ліворуч або знайти потрібну дію пошуком.']});
  return {audience,title:value.title,intro:value.intro,version:value.version,sections};
}
export function sectionSearchText(section) { return JSON.stringify(section).toLocaleLowerCase('uk-UA'); }
export function validateGuide(guide) {
  const ids=new Set();for(const section of guide.sections){if(typeof section.id!=='string'||!section.id||ids.has(section.id)||!section.title)throw new Error('Некоректний розділ посібника.');ids.add(section.id)}
  return guide;
}
