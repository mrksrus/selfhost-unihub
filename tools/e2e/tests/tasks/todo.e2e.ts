import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';

// 0-13: a scheduled task gets two subtasks, one done, and a 15-minute reminder. After a
// reload all of that is still there; marked done, the task moves to Done with its
// subtasks' state kept. (Reminder delivery needs a push device.)
test('[0-13] a task keeps its subtasks and reminder, and keeps them when done', { session: 'admin', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const title = `Subtasks ${runId()}`;
  const [first, second] = [`First step of ${title}`, `Second step of ${title}`];
  await app.open('/todo');
  await screen.getByRole('button', 'New task', { exact: true }).first().tap();
  await screen.getByLabel('Title', { exact: true }).fill(title);
  await screen.getByLabel('Give it a time in the calendar').tap();
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await screen.getByLabel('Start', { exact: true }).fill(`${day}T10:00`);
  await screen.getByLabel('End', { exact: true }).fill(`${day}T11:00`);
  await screen.getByRole('button', 'Create task', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden();

  let row = screen.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', `More actions for ${title}`).tap();
  await screen.getByRole('menuitem', 'Add a subtask', { exact: true }).tap();
  for (const subtask of [first, second]) {
    await screen.getByLabel(`Add a subtask to ${title}`).fill(subtask);
    await row.getByRole('button', 'Add', { exact: true }).tap();
    await expect(row.getByRole('checkbox', subtask)).toBeVisible();
  }
  await row.getByRole('checkbox', first).check();
  await row.getByRole('button', `More actions for ${title}`).tap();
  await screen.getByRole('menuitem', 'Edit', { exact: true }).tap();
  await screen.getByRole('combobox', 'Reminder 1').tap();
  await screen.getByRole('option', '15 minutes before', { exact: true }).tap();
  await screen.getByRole('button', 'Save changes', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden();

  await browser.reload();
  row = screen.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByRole('checkbox', first)).toBeChecked();
  await expect(row.getByRole('checkbox', second)).not.toBeChecked();
  await row.getByRole('button', `More actions for ${title}`).tap();
  await screen.getByRole('menuitem', 'Edit', { exact: true }).tap();
  await expect(screen.getByRole('combobox', 'Reminder 1')).toContainText('15 minutes before');
  await screen.getByRole('button', 'Cancel', { exact: true }).tap();

  await row.getByRole('button', `Mark ${title} done`).tap();
  await app.open('/todo?view=done');
  row = screen.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByRole('button', `Reopen ${title}`)).toBeVisible();
  await expect(row.getByRole('checkbox', first)).toBeChecked();
  await expect(row.getByRole('checkbox', second)).not.toBeChecked();
});
