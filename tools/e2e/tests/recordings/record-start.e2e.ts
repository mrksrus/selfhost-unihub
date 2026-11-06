import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Page = {
  addInitScript: (script: () => void) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
};
// The fake microphone the page sees: how often it was asked, and the test's
// hand on the answer (`grant`/`refuse`), so the question stays open exactly as
// long as the test needs, however fast or slow the runner.
type Microphone = { asks: number; grant: () => void; refuse: () => void; close: () => void };
type Window = { __microphone: Microphone };

// A microphone question answered only when the test says so, counting how often
// the page asked. The stream is a silent one from a second audio context, so the
// page records as it would from a real microphone without fake-device flags.
function fakeMicrophone() {
  if (!navigator.mediaDevices) return; // a frame without media (the init script runs in every frame)
  let producer: AudioContext | null = null;
  // The answer to the question open now; every ask opens its own.
  let answer: { grant: () => void; refuse: () => void } | null = null;
  const microphone: Microphone = {
    asks: 0,
    grant: () => answer?.grant(),
    refuse: () => answer?.refuse(),
    close: () => { void producer?.close(); },
  };
  (window as unknown as Window).__microphone = microphone;
  navigator.mediaDevices.getUserMedia = () => {
    microphone.asks += 1;
    return new Promise<MediaStream>((resolve, reject) => {
      answer = {
        grant: () => {
          producer ??= new AudioContext();
          resolve(producer.createMediaStreamDestination().stream);
        },
        refuse: () => reject(new DOMException('Permission denied', 'NotAllowedError')),
      };
    });
  };
}

const asks = (browser: Page) => browser.evaluate(() => (window as unknown as Window).__microphone.asks);
const grant = (browser: Page) => browser.evaluate(() => (window as unknown as Window).__microphone.grant());
const refuse = (browser: Page) => browser.evaluate(() => (window as unknown as Window).__microphone.refuse());
const closeMicrophone = (browser: Page) => browser.evaluate(() => (window as unknown as Window).__microphone.close());

// B-42: while the microphone question was open, Record stayed enabled and every
// further tap started another capture into the same recording. Now the first tap
// turns Record into a disabled spinner ("Starting recording"), a second tap asks for nothing more,
// and one recording runs once the microphone answers.
test('[B-42] Record asks for the microphone once while its question is pending', { session: 'admin', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const page = browser as unknown as Page;
  await page.addInitScript(fakeMicrophone);
  await app.open('/recordings');
  await screen.getByRole('button', 'Record', { exact: true }).tap();
  // The impatient second tap, on whatever the action reads now (on 0.27.2 still an enabled
  // Record); a point tap, since a disabled button fails the engine's actionability check.
  await screen.getByRole('button', /^(Record|Starting recording)$/).tap({ position: { x: 8, y: 8 } });
  expect(await asks(page), 'microphone requests after two taps').toBe(1);
  const starting = screen.getByRole('button', 'Starting recording', { exact: true });
  await expect(starting).toBeVisible();
  await expect(starting).toBeDisabled();

  await grant(page);
  await expect(screen.getByRole('button', 'Stop', { exact: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).not.toBeVisible();
  expect(await asks(page), 'microphone requests once recording').toBe(1);

  await screen.getByRole('button', 'Stop', { exact: true }).tap();
  await expect(screen.getByText('Save the recording', { exact: true })).toBeVisible();
  await screen.getByRole('button', 'Discard', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Record', { exact: true })).toBeEnabled();
  await closeMicrophone(page);
});

test('[B-42] a refused microphone returns Record to its idle state', { session: 'admin', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const page = browser as unknown as Page;
  await page.addInitScript(fakeMicrophone);
  await app.open('/recordings');
  await screen.getByRole('button', 'Record', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).toBeDisabled();
  await refuse(page);
  await expect(screen.getByText('Could not start recording', { exact: true })).toBeVisible();
  const record = screen.getByRole('button', 'Record', { exact: true });
  await expect(record).toBeEnabled();
  await expect(screen.getByRole('button', 'Stop', { exact: true })).not.toBeVisible();
  // Refused once is not refused for good.
  await record.tap();
  await expect(screen.getByRole('button', 'Starting recording', { exact: true })).toBeDisabled();
  expect(await asks(page), 'microphone requests').toBe(2);
});
