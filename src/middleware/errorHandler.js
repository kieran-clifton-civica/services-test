// Add error code information
// Standard error code list
// 200 - OK
// 400 - Bad Request (Client Error) - A json with error \ more details should return to the client.
// 401 - Unauthorized
// 500 - Internal Server Error - A json with an error should return to the client only when there is no security risk by doing that.
// Codes: DB error, notify error, tascomi error
// 1 - TascomiAuth failure
// 2 - TascomiRefNumber failure
// 3 - validation error
// 4 - sequelizeConnectionError
// 5 - notifyMissingKey
// 6 - notifyInvalidTemplate
// 7 - notifyMissingPersonalisation
const errorDetails = require("./errors.json");

const errorHandler = (err, req, res, next) => {
  if (err.name) {
    const errorDetail = errorDetails.find(error => {
      return error.name === err.name;
    });
    if (errorDetail.name === "validationError") {
      errorDetail.userMessages = err.validationErrors;
    }

    if (
      errorDetail.name === "notifyInvalidTemplate" ||
      errorDetail.name === "notifyMissingPersonalisation"
    ) {
      errorDetail.developerMessage = `${errorDetail.developerMessage} ${
        err.message
      }`;
    }

    res.status(errorDetail.statusCode);
    res.send({
      errorCode: errorDetail.code,
      developerMessage: errorDetail.developerMessage,
      userMessages: errorDetail.userMessages
    });
  } else {
    res.status(500);
    res.send({
      errorCode: "Unknown",
      developerMessage: "Unkown error found, debug and add to error cases",
      userMessages: ""
    });
  }
};

module.exports = { errorHandler };
