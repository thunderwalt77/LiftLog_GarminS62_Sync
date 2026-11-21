# Garmin Connect IQ Mobile SDK: talks to Garmin Connect over a binder service and exchanges
# Parcelables by class name, so R8 must not rename or strip it.
-keep class com.garmin.android.connectiq.** { *; }
-keep interface com.garmin.android.connectiq.** { *; }
-keep class com.garmin.monkeybrains.** { *; }
-dontwarn com.garmin.**
