/*
 *                      Copyright 2024 Salto Labs Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import _ from 'lodash'
import { Value, Values } from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import { RequiredDefinitions } from './types'
import { APIDefinitionsOptions } from './api'

const log = logger(module)
export const DEFINITIONS_OVERRIDES = 'SALTO_DEFINITIONS_OVERRIDES'

const getParsedDefinitionsOverrides = (): Values => {
  const overrides = process.env[DEFINITIONS_OVERRIDES]
  try {
    const parsedOverrides = overrides === undefined ? undefined : JSON.parse(overrides)
    if (parsedOverrides !== undefined && typeof parsedOverrides === 'object') {
      return parsedOverrides as Values
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      log.error('There was a syntax error in the JSON while parsing the overrides:', e.message)
    } else {
      log.error('An unknown error occurred while parsing the overrides:', e)
    }
  }
  return {}
}

/**
 * merge definitions with overrides from the environment variable SALTO_DEFINITIONS_OVERRIDES
 * the merge is done as follows:
 * - overrides takes precedence over definitions
 * - when merging an array the overrides array is used instead of the definitions array completely (no merge)
 * - when merging an object the overrides object is merged with the definitions object recursively
 * - we can use null to remove a field from the definitions as we override the original value with null and then remove it
 */
export const mergeDefinitionsWithOverrides = <Options extends APIDefinitionsOptions>(
  definitions: RequiredDefinitions<Options>,
): RequiredDefinitions<Options> => {
  const customMerge = (objValue: Value, srcValue: Value): Value => {
    if (_.isArray(objValue)) {
      return srcValue
    }
    return undefined
  }
  log.debug('starting to merge definitions with overrides')
  const overrides = getParsedDefinitionsOverrides()
  if (_.isEmpty(overrides)) {
    return definitions
  }
  log.debug('Definitions overrides:', overrides)
  const cloneDefinitions = _.cloneDeep(definitions)
  const merged = _.mergeWith(cloneDefinitions, overrides, customMerge)
  log.debug('Merged definitions with overrides:', merged)
  return merged
}
