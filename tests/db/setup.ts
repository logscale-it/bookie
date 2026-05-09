import { beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDb } from "./harness";
import { __setDbForTesting } from "../../src/lib/db/connection";

export let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  __setDbForTesting(testDb);
});

afterEach(async () => {
  __setDbForTesting(null);
  await testDb.close();
});
