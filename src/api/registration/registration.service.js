const moment = require("moment");
const fetch = require("node-fetch");

const {
  NOTIFY_TEMPLATE_ID_FBO,
  NOTIFY_TEMPLATE_ID_LC
} = require("../../config");

const {
  createRegistration,
  createEstablishment,
  createOperator,
  createActivities,
  createPremise,
  createMetadata,
  getRegistrationByFsaRn,
  getEstablishmentByRegId,
  getMetadataByRegId,
  getOperatorByEstablishmentId,
  getPremiseByEstablishmentId,
  getActivitiesByEstablishmentId,
  destroyRegistrationById,
  destroyEstablishmentByRegId,
  destroyMetadataByRegId,
  destroyOperatorByEstablishmentId,
  destroyPremiseByEstablishmentId,
  destroyActivitiesByEstablishmentId
} = require("../../connectors/registrationDb/registrationDb");

const {
  createFoodBusinessRegistration,
  createReferenceNumber
} = require("../../connectors/tascomi/tascomi.connector");

const { sendSingleEmail } = require("../../connectors/notify/notify.connector");

const {
  getAllLocalCouncilConfig,
  addDeletedId
} = require("../../connectors/configDb/configDb.connector");

const {
  transformDataForNotify
} = require("../../services/notifications.service");

const { logEmitter } = require("../../services/logging.service");

const saveRegistration = async (registration, fsa_rn) => {
  logEmitter.emit("functionCall", "registration.service", "saveRegistration");
  const reg = await createRegistration(fsa_rn);
  const establishment = await createEstablishment(
    registration.establishment.establishment_details,
    reg.id
  );
  const operator = await createOperator(
    registration.establishment.operator,
    establishment.id
  );
  const activities = await createActivities(
    registration.establishment.activities,
    establishment.id
  );
  const premise = await createPremise(
    registration.establishment.premise,
    establishment.id
  );
  const metadata = await createMetadata(registration.metadata, reg.id);
  logEmitter.emit(
    "functionSuccess",
    "registration.service",
    "saveRegistration"
  );
  return {
    regId: reg.id,
    establishmentId: establishment.id,
    operatorId: operator.id,
    activitiesId: activities.id,
    premiseId: premise.id,
    metadataId: metadata.id
  };
};

const getFullRegistrationByFsaRn = async fsa_rn => {
  logEmitter.emit(
    "functionCall",
    "registration.service",
    "getFullRegistrationByFsaRn"
  );
  const registration = await getRegistrationByFsaRn(fsa_rn);
  if (!registration) {
    return `No registration found for fsa_rn: ${fsa_rn}`;
  }
  const establishment = await getEstablishmentByRegId(registration.id);
  const metadata = await getMetadataByRegId(registration.id);
  const operator = await getOperatorByEstablishmentId(establishment.id);
  const activities = await getActivitiesByEstablishmentId(establishment.id);
  const premise = await getPremiseByEstablishmentId(establishment.id);
  logEmitter.emit(
    "functionSuccess",
    "registration.service",
    "getFullRegistrationByFsaRn"
  );
  return {
    registration,
    establishment,
    operator,
    activities,
    premise,
    metadata
  };
};

const deleteRegistrationByFsaRn = async fsa_rn => {
  const registration = await getRegistrationByFsaRn(fsa_rn);
  if (!registration) {
    return `No registration found for fsa_rn: ${fsa_rn}`;
  }
  const establishment = await getEstablishmentByRegId(registration.id);
  await destroyMetadataByRegId(registration.id);
  await destroyOperatorByEstablishmentId(establishment.id);
  await destroyActivitiesByEstablishmentId(establishment.id);
  await destroyPremiseByEstablishmentId(establishment.id);
  await destroyEstablishmentByRegId(registration.id);
  await destroyRegistrationById(registration.id);
  await addDeletedId(fsa_rn);
  logEmitter.emit(
    "functionSuccess",
    "registration.service",
    "getFullRegistrationByFsaRn"
  );
  return "Registration succesfully deleted";
};

const sendTascomiRegistration = async (registration, fsa_rn) => {
  logEmitter.emit(
    "functionCall",
    "registration.service",
    "sendTascomiRegistration"
  );
  try {
    const reg = await createFoodBusinessRegistration(registration, fsa_rn);
    const response = await createReferenceNumber(JSON.parse(reg).id);
    if (JSON.parse(response).id === 0) {
      const err = new Error("createReferenceNumber failed");
      err.name = "tascomiRefNumber";
      throw err;
    }
    logEmitter.emit(
      "functionSuccess",
      "registration.service",
      "sendTascomiRegistration"
    );
    return response;
  } catch (err) {
    logEmitter.emit(
      "functionFail",
      "registrationService",
      "sendTascomiRegistration",
      err
    );
    throw err;
  }
};

const getRegistrationMetaData = async () => {
  logEmitter.emit(
    "functionCall",
    "registration.service",
    "getRegistrationMetadata"
  );
  const reg_submission_date = moment().format("YYYY MM DD");
  const fsaRnResponse = await fetch(
    "https://fsa-rn.epimorphics.net/fsa-rn/1000/01"
  );
  let fsa_rn;
  if (fsaRnResponse.status === 200) {
    fsa_rn = await fsaRnResponse.json();
  }
  logEmitter.emit(
    "functionSuccess",
    "registration.service",
    "getRegistrationMetadata"
  );
  return {
    "fsa-rn": fsa_rn ? fsa_rn["fsa-rn"] : undefined,
    reg_submission_date: reg_submission_date
  };
};

const sendEmailOfType = async (
  typeOfEmail,
  registration,
  postRegistrationMetadata,
  lcContactConfig,
  recipientEmailAddress
) => {
  logEmitter.emit("functionCall", "registration.service", "sendEmailOfType");

  const emailSent = { success: undefined, recipient: recipientEmailAddress };

  let templateId;

  if (typeOfEmail === "LC") {
    templateId = NOTIFY_TEMPLATE_ID_LC;
  }
  if (typeOfEmail === "FBO") {
    templateId = NOTIFY_TEMPLATE_ID_FBO;
  }

  try {
    const data = transformDataForNotify(
      registration,
      postRegistrationMetadata,
      lcContactConfig
    );
    await sendSingleEmail(templateId, recipientEmailAddress, data);
    emailSent.success = true;
  } catch (err) {
    emailSent.success = false;
    logEmitter.emit(
      "functionFail",
      "registration.service",
      "sendEmailOfType",
      err
    );
  }
  logEmitter.emit("functionSuccess", "registration.service", "sendEmailOfType");
  return emailSent;
};

const getLcContactConfig = async localCouncilUrl => {
  logEmitter.emit("functionCall", "registration.service", "getLcContactConfig");

  if (localCouncilUrl) {
    const allLcConfigData = await getAllLocalCouncilConfig();

    const urlLcConfig = allLcConfigData.find(
      localCouncil => localCouncil.local_council_url === localCouncilUrl
    );

    if (urlLcConfig) {
      if (urlLcConfig.separate_standards_council) {
        const standardsLcConfig = allLcConfigData.find(
          localCouncil =>
            localCouncil._id === urlLcConfig.separate_standards_council
        );

        if (standardsLcConfig) {
          const separateCouncils = {
            hygiene: {
              code: urlLcConfig._id,
              local_council: urlLcConfig.local_council,
              local_council_notify_emails:
                urlLcConfig.local_council_notify_emails,
              local_council_email: urlLcConfig.local_council_email
            },
            standards: {
              code: standardsLcConfig._id,
              local_council: standardsLcConfig.local_council,
              local_council_notify_emails:
                standardsLcConfig.local_council_notify_emails,
              local_council_email: standardsLcConfig.local_council_email
            }
          };

          logEmitter.emit(
            "functionSuccess",
            "registration.service",
            "getLcContactConfig"
          );

          return separateCouncils;
        } else {
          const newError = new Error();
          newError.name = "localCouncilNotFound";
          newError.message = `A separate standards council config with the code "${
            urlLcConfig.separate_standards_council
          }" was expected for "${localCouncilUrl}" but does not exist`;
          logEmitter.emit(
            "functionFail",
            "registration.service",
            "getLcContactConfig",
            newError
          );
          throw newError;
        }
      } else {
        const hygieneAndStandardsCouncil = {
          hygieneAndStandards: {
            code: urlLcConfig._id,
            local_council: urlLcConfig.local_council,
            local_council_notify_emails:
              urlLcConfig.local_council_notify_emails,
            local_council_email: urlLcConfig.local_council_email
          }
        };

        logEmitter.emit(
          "functionSuccess",
          "registration.service",
          "getLcContactConfig"
        );

        return hygieneAndStandardsCouncil;
      }
    } else {
      const newError = new Error();
      newError.name = "localCouncilNotFound";
      newError.message = `Config for "${localCouncilUrl}" not found`;
      logEmitter.emit(
        "functionFail",
        "registration.service",
        "getLcContactConfig",
        newError
      );
      throw newError;
    }
  } else {
    const newError = new Error();
    newError.name = "localCouncilNotFound";
    newError.message = "Local council URL is undefined";
    logEmitter.emit(
      "functionFail",
      "registration.service",
      "getLcContactConfig",
      newError
    );
    throw newError;
  }
};

module.exports = {
  saveRegistration,
  getFullRegistrationByFsaRn,
  deleteRegistrationByFsaRn,
  sendTascomiRegistration,
  getRegistrationMetaData,
  sendEmailOfType,
  getLcContactConfig
};
