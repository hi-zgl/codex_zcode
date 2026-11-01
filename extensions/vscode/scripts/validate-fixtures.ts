import {loadMockFixture} from '../src/host/mock.js';
import {resolve} from 'node:path';
void loadMockFixture(resolve(__dirname,'../test/fixtures/pool-demo.json')).then(()=>console.log('Mock fixture schema and integrity verified.'));
