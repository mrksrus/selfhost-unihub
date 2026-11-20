// Stands in for src/hooks/use-chat-engine.ts in the build the reference
// pictures are taken from (tools/ui-regression/support/vite-build.mts): the
// Chat screens get the fixed engine when a test asked for one before the
// page loaded, and no engine otherwise, so every other picture is without Chat.
import { createFixtureChatEngine, type MockChatOptions } from './chat-mock-engine';

const options = (window as { uiRegressionChat?: MockChatOptions }).uiRegressionChat;
const engine = options ? createFixtureChatEngine(options) : null;

export const useChatEngine = () => engine;
