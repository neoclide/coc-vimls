import { delimiter, resolve } from 'node:path'

// Use a freshly built server without hard-coding a developer checkout in the extension.
process.env.PATH = `${resolve(process.env.VIMLS_TEST_BIN || '.test-bin')}${delimiter}${process.env.PATH || ''}`
