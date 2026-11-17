package com.walletchan.android

import org.json.JSONArray
import org.json.JSONObject

object JsonUtils {
    /** Serializes any value obtained from org.json (`opt()`) back to JSON text. */
    fun valueToJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject, is JSONArray -> value.toString()
        is String -> JSONObject.quote(value)
        is Boolean -> value.toString()
        is Number -> JSONObject.numberToString(value)
        else -> JSONObject.quote(value.toString())
    }

    fun obj(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply {
        for ((k, v) in pairs) put(k, v ?: JSONObject.NULL)
    }
}
