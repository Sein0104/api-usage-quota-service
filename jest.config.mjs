export default {
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*(\\.spec|\\.e2e-spec|\\.int-spec|\\.concurrent-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
};
