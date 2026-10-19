package ink.xelay.android.data

enum class ApiOperation { SIGN_IN, REFRESH, DATA, SIGN_OUT }

class ApiFailure(val status: Int, val apiCode: String = "", val operation: ApiOperation = ApiOperation.DATA) :
    Exception("XELAY_REQUEST_FAILED")
class SessionChanged : Exception("XELAY_SESSION_CHANGED")
class SessionExpired(val reference: String = "AUTH_SESSION_EXPIRED") : Exception("XELAY_SESSION_EXPIRED")
class SecureStorageFailure : Exception("XELAY_SECURE_STORAGE")
