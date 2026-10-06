package app.xvi.note;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class ServerConfigTest {
    @Test
    public void acceptsADomainOrTheSiteRootOverHttps() {
        assertEquals("note.example.com", ServerConfig.normalize(" note.example.com "));
        assertEquals("note.example.com", ServerConfig.normalize("https://Note.Example.com/"));
        assertEquals("a-b.example.org", ServerConfig.normalize("https://a-b.example.org:443"));
    }

    @Test
    public void refusesAnythingBesidesAnHttpsSiteRoot() {
        for (String value : new String[] {
            "", "  ", "http://note.example.com", "https://note.example.com/app",
            "https://note.example.com/?x=1", "https://note.example.com/#setup=t",
            "https://user@note.example.com", "https://note.example.com:8443", "localhost",
            "https://-bad.example.com", "https://note_example.com", "ftp://note.example.com"
        }) assertThrows(value, IllegalArgumentException.class, () -> ServerConfig.normalize(value));
    }
}
