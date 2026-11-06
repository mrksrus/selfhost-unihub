import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Page = {
  addInitScript: (script: () => void) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
};
type Asked = { __microphoneAsks: number };

// A microphone that answers only after a while, as a browser's or Android's
// permission question does, counting how often the page asked. The stream is a
// silent one from a second audio context, so the page records as it would from a
// real microphone without the engine's fake-device flags.
function slowMicrophone() {
  if (!navigator.mediaDevices) return; // a frame without media (the init script runs in every frame)
  const w = window as unknown as Asked;
  w.__microphoneAsks = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    w.__microphoneAsks += 1;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const context = new AudioContext();
    return context.createMediaStreamDestination().stream;
  };
}

// A microphone question answered "no" after a while.
function refusingMicrophone() {
  if (!navigator.mediaDevices) return; // a frame without media (the init script runs in every frame)
  const w = window as unknown as Asked;
  w.__microphoneAsks = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    w.__microphoneAsks += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    throw new DOMException('Permission denied', 'NotAllowedError');
  };
}

const asks = (browser: Page) => browser.evaluate(() => (window as unknown as Asked).__microphoneAsks);

// B-42: while the microphone question was open, Record stayed enabled and every
// further tap started another capture into the same recording. Now the first tap
// turns Record into a disabled spinner ("Starting recording"), a second tap asks for nothing more,
// and one recording runs once the microphone answers.
test('[B-42] Record asks for the microphone once while its question is pending', { session: 'admin', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const page = browser as unknown as Page;
  await page.addInitScript(slowMicrophone);
  await app.open('/recordings');
  await screen.getByRole('button', 'Record', { exact: true }).tap();
  // The impatient second tap, on whatever the action reads now (on 0.27.2 still an enabled
  // Record); a point tap, since a disabled button fails the engine's actionability check.
  await screen.getByRole('button', /^(Record|Starting recording)$/).tap({ position: { x: 8, y: 8 } });
  expect(await asks(page), 'microphone requests after two taps').toBe(1);
  const starting = screen.getByRole('button', 'Starting recording', { exact: true });
  await expect(starting).toBeVisible();
  await expect(starting).toBeDisabled();

  await expect(screen.getByRole('button', 'Stop', { exact: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).not.toBeVisible();
  expect(await asks(page), 'microphone requests once recording').toBe(1);

  await screen.getByRole('button', 'Stop', { exact: true }).tap();
  await expect(screen.getByText('Save the recording', { exact: true })).toBeVisible();
  await screen.getByRole('button', 'Discard', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Record', { exact: true })).toBeEnabled();
});

test('[B-42] a refused microphone returns Record to its idle state', { session: 'admin', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const page = browser as unknown as Page;
  await page.addInitScript(refusingMicrophone);
  await app.open('/recordings');
  await screen.getByRole('button', 'Record', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).toBeDisabled();
  await expect(screen.getByText('Could not start recording', { exact: true })).toBeVisible();
  const record = screen.getByRole('button', 'Record', { exact: true });
  await expect(record).toBeEnabled();
  await expect(screen.getByRole('button', 'Stop', { exact: true })).not.toBeVisible();
  // Refused once is not refused for good.
  await record.tap();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).toBeDisabled();
  expect(await asks(page), 'microphone requests').toBe(2);
});
