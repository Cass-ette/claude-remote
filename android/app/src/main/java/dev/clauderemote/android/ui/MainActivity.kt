package dev.clauderemote.android.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import dev.clauderemote.android.R

/**
 * Single-activity Compose host. The navigation graph with connection,
 * sessions, conversation, permission, and import screens is added by later
 * tasks; for now it renders one placeholder screen.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Text(text = stringResource(R.string.app_name))
                }
            }
        }
    }
}
