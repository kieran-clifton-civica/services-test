const moment = require("moment");
const { validate } = require("../../services/validation.service");
const {
  getFullRegistrationByFsaRn,
  deleteRegistrationByFsaRn,
  getRegistrationMetaData,
  getLcContactConfig
} = require("./registration.service");

const {
  cacheRegistration
} = require("../../connectors/cacheDb/cacheDb.connector");

const { getUprn } = require("../../connectors/address-lookup/address-matcher");

const {
  findCouncilByUrl,
  findCouncilById,
  connectToConfigDb,
  LocalCouncilConfigDbCollection
} = require("../../connectors/configDb/configDb.connector");

const {
  mapFromCollectionsRegistration
} = require("../../utils/registrationMapper");

const { logEmitter } = require("../../services/logging.service");

const createNewRegistration = async (
  registration,
  localCouncilUrl,
  regDataVersion,
  sendResponse
) => {
  logEmitter.emit(
    "functionCall",
    "registration.controller",
    "createNewRegistration"
  );

  if (registration === undefined) {
    throw new Error("registration is undefined");
  }

  const errors = validate(registration);
  if (errors.length) {
    const err = new Error();
    err.name = "validationError";
    err.validationErrors = errors;
    throw err;
  }

  // RESOLUTION
  let configDb = await connectToConfigDb();
  const lcConfigCollection = await LocalCouncilConfigDbCollection(configDb);

  const sourceCouncil = await findCouncilByUrl(
    lcConfigCollection,
    localCouncilUrl
  );

  //left here as legacy code
  const lcContactConfig = await getLcContactConfig(localCouncilUrl);

  let hygieneCouncilCode;
  if (lcContactConfig.hygieneAndStandards) {
    hygieneCouncilCode = lcContactConfig.hygieneAndStandards.code;
  } else {
    hygieneCouncilCode = lcContactConfig.hygiene.code;
  }

  const postRegistrationMetadata = await getRegistrationMetaData(
    hygieneCouncilCode
  );

  const status = {
    registration: null,
    notifications: null
  };
  if (sourceCouncil.auth) {
    status.tascomi = {};
  }

  //this is all very messy but ported from legacy code.
  const completeCacheRecord = Object.assign(
    {},
    {
      "fsa-rn": postRegistrationMetadata["fsa-rn"],
      reg_submission_date: postRegistrationMetadata.reg_submission_date,
      directLcSubmission: false
    },
    registration,
    lcContactConfig,
    {
      status: status
    },
    {
      hygiene_council_code: hygieneCouncilCode,
      local_council_url: localCouncilUrl,
      //the council id resolved from the localCouncilUrl
      source_council_id: sourceCouncil._id,
      registration_data_version: regDataVersion
    },
    postRegistrationMetadata
  );

  await cacheRegistration(completeCacheRecord);

  const combinedResponse = Object.assign({}, postRegistrationMetadata, {
    lc_config: lcContactConfig
  });

  sendResponse(combinedResponse);

  logEmitter.emit(
    "functionSuccess",
    "registration.controller",
    "createNewRegistration"
  );
};

const createNewLcRegistration = async (
  registration,
  regDataVersion,
  sendResponse
) => {
  logEmitter.emit(
    "functionCall",
    "registration.controller",
    "createNewLcRegistration"
  );

  if (registration === undefined) {
    throw new Error("registration is undefined");
  }

  // Validate according to correct schema
  const errors = validate(registration, true);
  if (errors.length) {
    const err = new Error();
    err.name = "validationError";
    err.validationErrors = errors;
    throw err;
  }

  // Convert to correct format
  const mappedRegistration = mapFromCollectionsRegistration(registration);

  // RESOLUTION
  let configDb = await connectToConfigDb();
  const lcConfigCollection = await LocalCouncilConfigDbCollection(configDb);

  // Get Council details
  const sourceCouncil = await findCouncilById(
    lcConfigCollection,
    registration.competent_authority_id
  );
  if (!sourceCouncil) {
    const newError = new Error();
    newError.name = "localCouncilNotFound";
    newError.message = `Config for council ID "${registration.competent_authority_id}" not found`;
    logEmitter.emit(
      "functionFail",
      "registration.controller",
      "createNewLcRegistration",
      newError
    );
    throw newError;
  }

  // Get UPRN of establishment and operator
  const promises = [];
  if (!mappedRegistration.establishment.operator.operator_uprn) {
    promises.push(
      getUprn(
        mappedRegistration.establishment.operator.operator_address_line_1,
        mappedRegistration.establishment.operator.operator_postcode
      ).then(
        (result) =>
          (mappedRegistration.establishment.operator.operator_uprn = result)
      )
    );
  }

  if (!mappedRegistration.establishment.premise.establishment_uprn) {
    promises.push(
      getUprn(
        mappedRegistration.establishment.premise.establishment_address_line_1,
        mappedRegistration.establishment.premise.establishment_postcode
      ).then(
        (result) =>
          (mappedRegistration.establishment.premise.establishment_uprn = result)
      )
    );
  }

  //left here as legacy code
  let lcContactConfig;
  promises.push(
    getLcContactConfig(sourceCouncil.local_council_url).then(
      (result) => (lcContactConfig = result)
    )
  );

  // Wait for asyncs to catch up
  await Promise.all(promises);

  let hygieneCouncilCode;
  if (lcContactConfig.hygieneAndStandards) {
    hygieneCouncilCode = lcContactConfig.hygieneAndStandards.code;
  } else {
    hygieneCouncilCode = lcContactConfig.hygiene.code;
  }

  let reg_metadata = {
    "fsa-rn": registration.fsa_rn,
    reg_submission_date: moment().format("YYYY-MM-DD"),
    directLcSubmission: true,
    createdAt: registration.createdAt || moment().format(),
    updatedAt: registration.updatedAt || moment().format()
  };

  if (!reg_metadata["fsa-rn"]) {
    await getRegistrationMetaData(hygieneCouncilCode).then(
      (result) => (reg_metadata["fsa-rn"] = result["fsa-rn"])
    );
  }

  const status = {
    registration: null,
    notifications: null
  };

  const completeCacheRecord = Object.assign(
    {},
    reg_metadata,
    mappedRegistration,
    lcContactConfig,
    {
      status: status
    },
    {
      hygiene_council_code: hygieneCouncilCode,
      local_council_url: sourceCouncil.local_council_url,
      source_council_id: sourceCouncil._id,
      registration_data_version: regDataVersion
    }
  );

  await cacheRegistration(completeCacheRecord);

  const combinedResponse = Object.assign({}, reg_metadata, {
    lc_config: lcContactConfig
  });

  sendResponse(combinedResponse);

  logEmitter.emit(
    "functionSuccess",
    "registration.controller",
    "createNewLcRegistration"
  );
};

const getRegistration = async (fsa_rn) => {
  const response = await getFullRegistrationByFsaRn(fsa_rn);

  return response;
};

const deleteRegistration = async (fsa_rn) => {
  const response = await deleteRegistrationByFsaRn(fsa_rn);

  return response;
};

module.exports = {
  createNewRegistration,
  createNewLcRegistration,
  getRegistration,
  deleteRegistration
};
