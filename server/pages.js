const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F6F7F7;color:#111;font:400 16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 20px 56px}
main{max-width:640px;margin:0 auto}
h1{font:700 32px/1.05 "Arial Narrow",Arial,sans-serif;text-transform:uppercase;letter-spacing:-.01em;margin:0 0 16px}
h2{font:700 18px/1.2 system-ui,sans-serif;margin:32px 0 8px}
p,li{margin:0 0 12px;color:#111}
ul{padding-left:20px}
small,.note{color:#5E6266;font-size:14px}
.draft{background:#BBE5F2;border:1px solid #111;padding:12px 16px;border-radius:16px;margin:0 0 24px}
input,button{font:inherit;width:100%;min-height:48px;padding:0 16px;border:1px solid #111;border-radius:16px;background:#fff;margin:4px 0 16px}
button{background:#111;color:#F6F7F7;font-weight:600;cursor:pointer}
label{font-weight:600;font-size:14px}
.err{color:#B3261E}
`;

export function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${BASE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * Политика обработки персональных данных: рабочий черновик под наш продукт.
 * Финальный текст должен утвердить юрист. Пока POLICY_DRAFT не равен 0, наверху стоит пометка.
 */
export function policyPage(cfg) {
  const o = cfg.operator;
  const who = o.name ? esc(o.name) + (o.inn ? ', ИНН ' + esc(o.inn) : '') : '[имя или название оператора, ИНН]';
  const contact = o.contact ? esc(o.contact) : '[почта для обращений]';
  const host = o.hosting ? esc(o.hosting) : '[хостинг-провайдер и страна размещения]';
  const draft = cfg.policyDraft ? '<div class="draft"><b>Черновик.</b> Текст ещё не проверял юрист. Перед публичным запуском его нужно утвердить.</div>' : '';
  return page('Политика обработки данных', `
${draft}
<h1>Политика обработки данных</h1>
<p class="note">Сервис «тропа покупок» (мини-приложение и бот в Telegram).</p>

<h2>Кто обрабатывает</h2>
<p>Оператор: ${who}. Контакт для обращений: ${contact}.</p>

<h2>Какие данные мы храним</h2>
<ul>
<li>Числовой идентификатор Telegram и имя из профиля Telegram (то, что отдаёт сам Telegram при открытии приложения).</li>
<li>Всё, что вы добавляете сами: названия вещей, цены, сколько отложено, приоритет, иконка и цвета, ссылка на товар, фото, история «куплено».</li>
<li>Настройки: включена ли недельная сводка, обычная сумма в неделю.</li>
<li>Согласие на обработку: когда и где (в боте или в приложении) вы его дали.</li>
</ul>
<p>Мы не храним номер телефона, адрес, платёжные данные и данные банковских карт. Мы не просим их и не открываем ссылки на магазины.</p>

<h2>Зачем</h2>
<p>Чтобы показывать вам вашу тропу покупок на разных устройствах, считать накопления и присылать недельную сводку в бот. Больше ни для чего данные не используются: не продаём, не передаём рекламным сетям, не строим профилей.</p>

<h2>На каком основании</h2>
<p>На основании вашего согласия. Вы даёте его кнопкой «Принимаю» в боте или в приложении.</p>

<h2>Где хранятся</h2>
<p>Данные хранятся у хостинг-провайдера: ${host}. Сообщения бота проходят через Telegram как платформу доставки.</p>

<h2>Сколько храним</h2>
<p>Пока вы пользуетесь сервисом. После удаления данные пропадают с рабочей базы сразу, из резервных копий уходят в течение 14 дней.</p>

<h2>Как всё удалить или отозвать согласие</h2>
<ul>
<li>В боте: команда /delete_me.</li>
<li>В приложении: профиль, «Удалить аккаунт и все данные».</li>
<li>Или напишите на ${contact}.</li>
</ul>
<p>Выключить недельную сводку: команда /digest_off или переключатель в профиле.</p>

<h2>Ваши права</h2>
<p>Вы можете запросить, какие данные мы о вас храним, исправить их, потребовать удаления и отозвать согласие. Пишите на ${contact}.</p>
`);
}
