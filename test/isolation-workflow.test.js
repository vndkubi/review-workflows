'use strict';
// The isolation workflow must be able to run the Docker tests on a clean
// runner: the tests inspect local images and never pull them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'isolation.yml'), 'utf8');

test('the isolation workflow pulls every image its Docker tests inspect', () => {
  for (const image of ['maven:3.9-eclipse-temurin-8', 'maven:3.9-eclipse-temurin-11', 'maven:3.9-eclipse-temurin-17']) {
    assert.match(WORKFLOW, new RegExp(`docker\\s+pull\\s+${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${image} is never pulled`);
  }
});
