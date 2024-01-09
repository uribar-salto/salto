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
import { ElemID, InstanceElement } from '@salto-io/adapter-api'
import { formatConfigSuggestionsReasons } from '@salto-io/adapter-utils'
import { values } from '@salto-io/lowerdash'
import { FailedFiles } from '../client/types'
import { FetchTypeQueryParams, LockedElementsConfig, NetsuiteConfig, NetsuiteFilePathsQueryParams, NetsuiteTypesQueryParams, QueryParams, configType } from './types'
import { FetchByQueryFailures, convertToQueryParams, isCriteriaQuery } from './query'
import { emptyQueryParams, fullFetchConfig } from './config_creator'

export const STOP_MANAGING_ITEMS_MSG = 'Salto failed to fetch some items from NetSuite.'
  + ' Failed items must be excluded from the fetch.'

export const LARGE_FOLDERS_EXCLUDED_MESSAGE = 'Some File Cabinet folders exceed File Cabinet\'s size limitation.'
 + ' To include them, increase the File Cabinet\'s size limitation and remove their exclusion rules from the configuration file.'

export const LARGE_TYPES_EXCLUDED_MESSAGE = 'Some types were excluded from the fetch as the elements of that type were too numerous.'
 + ' To include them, increase the types elements\' size limitations and remove their exclusion rules.'

const createFolderExclude = (folderPaths: NetsuiteFilePathsQueryParams): string[] =>
  folderPaths.map(folder => `^${_.escapeRegExp(folder)}.*`)

const createExclude = (
  failedPaths: NetsuiteFilePathsQueryParams = [],
  failedTypes: NetsuiteTypesQueryParams = {},
): QueryParams =>
  ({
    fileCabinet: failedPaths.map(_.escapeRegExp),
    types: Object.entries(failedTypes).map(([name, ids]) => ({ name, ids })),
  })

const toConfigSuggestions = ({
  failedToFetchAllAtOnce,
  failedFilePaths,
  failedTypes,
}: FetchByQueryFailures): NetsuiteConfig => {
  const config: NetsuiteConfig = {
    fetch: fullFetchConfig(),
  }

  if (!_.isEmpty(failedFilePaths.otherError) || !_.isEmpty(failedTypes.unexpectedError)) {
    config.fetch = {
      ...config.fetch,
      exclude: createExclude(
        failedFilePaths.otherError,
        failedTypes.unexpectedError,
      ),
    }
  }
  if (!_.isEmpty(failedFilePaths.lockedError) || !_.isEmpty(failedTypes.lockedError)) {
    config.fetch = {
      ...config.fetch,
      lockedElementsToExclude: createExclude(
        failedFilePaths.lockedError,
        failedTypes.lockedError,
      ),
    }
  }
  if (failedToFetchAllAtOnce) {
    config.client = {
      ...config.client,
      fetchAllTypesAtOnce: false,
    }
  }
  return config
}

const combineFetchTypeQueryParams = (
  first: FetchTypeQueryParams[],
  second: FetchTypeQueryParams[]
): FetchTypeQueryParams[] => Object.entries(
  _.groupBy(first.concat(second), type => type.name)
).flatMap(([name, types]) => {
  const [byCriteriaQueries, byIdsQueries] = _.partition(types, isCriteriaQuery)
  const combinedByIdsQuery = byIdsQueries.length > 0 ? [{
    name,
    ...byIdsQueries.some(type => type.ids === undefined)
      ? {}
      : { ids: _.uniq(byIdsQueries.flatMap(type => type.ids ?? [])) },
  }] : []
  const uniqByCriteriaQueries = _.uniqWith(byCriteriaQueries, _.isEqual)
  return [...combinedByIdsQuery, ...uniqByCriteriaQueries]
})

const combineQueryParams = (
  first: QueryParams | undefined,
  second: QueryParams | undefined,
): QueryParams => {
  if (first === undefined || second === undefined) {
    return first ?? second ?? emptyQueryParams()
  }

  const newFileCabinet = _(first.fileCabinet).concat(second.fileCabinet).uniq().value()
  const newTypes = combineFetchTypeQueryParams(first.types, second.types)
  const newCustomRecords = first.customRecords || second.customRecords ? {
    customRecords: combineFetchTypeQueryParams(
      first.customRecords ?? [],
      second.customRecords ?? []
    ),
  } : {}

  return {
    fileCabinet: newFileCabinet,
    types: newTypes,
    ...newCustomRecords,
  }
}

const updateConfigFromFailedFetch = (config: NetsuiteConfig, failures: FetchByQueryFailures): boolean => {
  const suggestions = toConfigSuggestions(failures)
  if (_.isEqual(suggestions, {
    fetch: fullFetchConfig(),
  })) {
    return false
  }

  const {
    fetch: currentFetchConfig,
    client: currentClientConfig,
  } = config
  const {
    fetch: suggestedFetchConfig,
    client: suggestedClientConfig,
  } = suggestions

  if (suggestedClientConfig?.fetchAllTypesAtOnce !== undefined) {
    config.client = {
      ...currentClientConfig,
      fetchAllTypesAtOnce: suggestedClientConfig.fetchAllTypesAtOnce,
    }
  }

  const updatedFetchConfig = {
    ...currentFetchConfig,
    exclude: combineQueryParams(currentFetchConfig?.exclude, suggestedFetchConfig?.exclude),
  }

  const newLockedElementToExclude = combineQueryParams(
  currentFetchConfig?.lockedElementsToExclude,
  suggestedFetchConfig?.lockedElementsToExclude
  )

  if (!_.isEqual(newLockedElementToExclude, emptyQueryParams())) {
    updatedFetchConfig.lockedElementsToExclude = newLockedElementToExclude
  }

  config.fetch = updatedFetchConfig
  return true
}

const updateConfigFromLargeFolders = (config: NetsuiteConfig, { largeFolderError }: FailedFiles): boolean => {
  if (largeFolderError && !_.isEmpty(largeFolderError)) {
    const largeFoldersToExclude = convertToQueryParams({ filePaths: createFolderExclude(largeFolderError) })
    config.fetch = {
      ...config.fetch,
      exclude: combineQueryParams(config.fetch.exclude, largeFoldersToExclude),
    }
    return true
  }
  return false
}

const updateConfigFromLargeTypes = (
  config: NetsuiteConfig,
  { failedTypes, failedCustomRecords }: FetchByQueryFailures
): boolean => {
  const { excludedTypes } = failedTypes
  if (!_.isEmpty(excludedTypes) || !_.isEmpty(failedCustomRecords)) {
    const customRecords = failedCustomRecords.map(type => ({ name: type }))
    const typesExcludeQuery = {
      fileCabinet: [],
      types: excludedTypes.map(type => ({ name: type })),
      ...(!_.isEmpty(customRecords) && { customRecords }),
    }
    config.fetch = {
      ...config.fetch,
      exclude: combineQueryParams(config.fetch.exclude, typesExcludeQuery),
    }
    return true
  }
  return false
}

const toConfigInstance = (config: NetsuiteConfig): InstanceElement =>
  new InstanceElement(ElemID.CONFIG_NAME, configType, _.pickBy(config, values.isDefined))

const splitConfig = (config: NetsuiteConfig): InstanceElement[] => {
  const {
    lockedElementsToExclude,
    ...allFetchConfigExceptLockedElements
  } = config.fetch
  if (lockedElementsToExclude === undefined) {
    return [toConfigInstance(config)]
  }
  config.fetch = allFetchConfigExceptLockedElements
  const lockedElementsConfig: LockedElementsConfig = {
    fetch: {
      lockedElementsToExclude,
    },
  }
  return [
    toConfigInstance(config),
    new InstanceElement(
      ElemID.CONFIG_NAME,
      configType,
      lockedElementsConfig,
      ['lockedElements']
    ),
  ]
}

export const getConfigFromConfigChanges = (
  failures: FetchByQueryFailures,
  currentConfig: NetsuiteConfig,
): { config: InstanceElement[]; message: string } | undefined => {
  const config = _.cloneDeep(currentConfig)
  const didUpdateFromFailures = updateConfigFromFailedFetch(config, failures)
  const didUpdateLargeFolders = updateConfigFromLargeFolders(config, failures.failedFilePaths)
  const didUpdateLargeTypes = updateConfigFromLargeTypes(config, failures)

  const messages = [
    didUpdateFromFailures
      ? STOP_MANAGING_ITEMS_MSG
      : undefined,
    didUpdateLargeFolders
      ? LARGE_FOLDERS_EXCLUDED_MESSAGE
      : undefined,
    didUpdateLargeTypes
      ? LARGE_TYPES_EXCLUDED_MESSAGE
      : undefined,
  ].filter(values.isDefined)

  return messages.length > 0 ? {
    config: splitConfig(config),
    message: formatConfigSuggestionsReasons(messages),
  } : undefined
}