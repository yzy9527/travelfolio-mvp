import test from 'node:test';
import assert from 'node:assert/strict';
import {operationService,safeDiagnostic} from '../src/worker';

test('operation diagnostics classify canonical ledger keys after the job prefix is removed',()=>{
  assert.equal(operationService('outline'),'模型大纲');
  assert.equal(operationService('research:framing'),'模型研究');
  assert.equal(operationService('research:places-core'),'模型研究');
  assert.equal(operationService('evidence:framing:search:destination-v2:0'),'Brave 搜索');
  assert.equal(operationService('evidence:framing:search:0'),'Brave 搜索');
  assert.equal(operationService('unrelated'),'外部调用');
  assert.match(safeDiagnostic({operation_key:'research:framing',status:'ambiguous',failure_code:'PROVIDER_INVALID_RESPONSE'},null),/^模型研究；错误 PROVIDER_INVALID_RESPONSE$/);
  assert.match(safeDiagnostic({operation_key:'evidence:framing:search:destination-v2:0',status:'ambiguous',failure_code:'PROVIDER_RATE_LIMITED',failure_phase:'response',http_status:429},null),/^Brave 搜索；阶段 response；错误 PROVIDER_RATE_LIMITED；HTTP 429$/);
  assert.match(safeDiagnostic({operation_key:'outline',status:'ambiguous',failure_code:'PROVIDER_OUTLINE_SCHEMA',failure_detail:'outline.days.0.pace.invalid_enum_value'},null),/字段 outline.days.0.pace.invalid_enum_value/);
});
